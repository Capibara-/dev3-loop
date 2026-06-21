/**
 * Composition root + reconcile tick loop.
 *
 * This is the **imperative shell** around the pure {@link decide} core. It wires
 * the seven ports (Fakes in tests, real adapters) into a {@link Loop} and
 * drives the level-triggered reconcile:
 *
 * ```
 * tick():
 *   cards   = board.listCards()
 *   journal = journal.loadAll()
 *   slots   = promotionBudget(cards, journal)   // computed ONCE, consumed sequentially
 *   for card in cards:
 *     obs     = observe(card)                    // cheap, side-effect-free reads
 *     actions = decide(card, journal[card.id], policy, obs, now)   // PURE → ordered Action[]
 *     for a in actions:                          // [] = NoOp
 *       if a is a promotion and slots <= 0: skip the rest of this card (fleet gate)
 *       eventLog.append(intent(a))               // write-ahead, per action
 *       journal = fold(execute(a) into journal)  // the only I/O
 *       if a is a promotion: slots -= 1
 *       journal.persist(journal); eventLog.append(done(a))
 * ```
 *
 * Three load-bearing invariants:
 *  - **The fleet promotion gate lives HERE, not in `decide()`**: a
 *    per-card boolean would race, so the budget is a counter the shell spends
 *    sequentially. It currently ships as a SEAM with a trivial concurrency budget
 *    ({@link concurrencyBudget}); the full caps/breaker policy lands later.
 *  - **The shell folds every evaluation into an `AttemptRecord`** — both
 *    `RunChecks` results AND reviewer `changes_requested` verdicts (the latter as a
 *    **red** attempt that feeds `consecutiveFailures` + the breaker), and it
 *    sets `fixPromptSent` whenever it dispatches a `SendFixPrompt`, giving
 *    exactly-once fix delivery.
 *  - **The journal is the single source of truth**; the event log is an
 *    append-only audit trace, never replayed into state.
 *
 * `dry-run` mode computes `observe()`/`decide()` (side-effect-free reads only) and
 * returns the intended {@link PlannedAction}s **without** performing a single port
 * mutation — no moves, launches, checks, merges, journal writes, or log appends.
 *
 * @module app/loop
 */

import {
  applyHumanResume,
  decide,
  routingKey,
  type GiveUpPredicate,
} from "../domain/reconcile.ts";
import { guardrails } from "../domain/guardrails.ts";
import { evaluateFleet, liveCount, type FleetDecision, type FleetOptions } from "../domain/fleet.ts";
import { recover } from "./recover.ts";
import type {
  Action,
  AttemptRecord,
  Card,
  CardJournal,
  CardPolicy,
  CustomColumnId,
  Lane,
} from "../domain/types.ts";
import type {
  BoardPort,
  ClockPort,
  ConfigPort,
  EventLogPort,
  GitPort,
  JournalPort,
  RuntimePort,
} from "../ports/index.ts";
import type { CheckResult, LoopEvent, Observation } from "../ports/dto.ts";

// --- port bundle ----------------------------------------------------------

/** The seven seams the shell drives. Fakes in tests, real adapters in production. */
export interface LoopPorts {
  board: BoardPort;
  runtime: RuntimePort;
  git: GitPort;
  journal: JournalPort;
  eventLog: EventLogPort;
  clock: ClockPort;
  config: ConfigPort;
}

// --- fleet promotion gate (seam) ------------------------------------------

/**
 * The fleet promotion budget: how many `todo` cards may be
 * promoted to `in-progress` this tick. Computed ONCE per tick over the full card
 * list and **consumed sequentially** by the shell — never a per-card field (that
 * would race). It currently ships {@link concurrencyBudget}; the daily-spend
 * ceiling + circuit breaker land later.
 */
export type PromotionBudget = (
  cards: readonly Card[],
  journals: Readonly<Record<string, CardJournal>>,
) => number;

/** Concurrency-only budget (`cap − live`); a `promotionBudget` override / seam. The
 *  full policy (+ spend ceiling + breaker) is {@link evaluateFleet}, the loop default. */
export function concurrencyBudget(cap: number): PromotionBudget {
  return (cards, journals) => Math.max(0, cap - liveCount(cards, journals));
}

// --- the loop -------------------------------------------------------------

/** A single intended effect surfaced by a tick (for dry-run logging / assertions). */
export interface PlannedAction {
  /** The card the action concerns. */
  cardId: string;
  /** The {@link Action} `decide()` proposed (and that the shell executed, unless dry-run / gated). */
  action: Action;
  /** True when the fleet gate held this promotion back this tick (dry-run plan only). */
  gated?: boolean;
}

/** Defaults for the fleet policy knobs, applied when {@link LoopConfig} omits them. */
export const FLEET_DEFAULTS = {
  dailySpendCeiling: Number.POSITIVE_INFINITY,
  breakerWindow: 10,
  breakerThreshold: 0.5,
  breakerMinSamples: 4,
  spendWindowMs: 86_400_000, // 24h
} as const;

/** Knobs for {@link createLoop}. */
export interface LoopConfig {
  /** Fleet live-card concurrency cap. */
  concurrencyCap: number;
  /** When true, compute the plan but perform ZERO port mutations. */
  dryRun?: boolean;
  /** Concurrency-only budget override; bypasses the full {@link evaluateFleet} policy. */
  promotionBudget?: PromotionBudget;
  /** Guardrail give-up predicate; defaults to the real {@link guardrails}. */
  shouldGiveUp?: GiveUpPredicate;
  // Fleet-policy overrides; each falls back to FLEET_DEFAULTS.
  dailySpendCeiling?: number;
  breakerWindow?: number;
  breakerThreshold?: number;
  breakerMinSamples?: number;
  spendWindowMs?: number;
}

/** The reconciler: one {@link Loop.tick} = one full level-triggered reconcile. */
export interface Loop {
  /** Run one reconcile pass; returns the intended actions (executed unless dry-run). */
  tick(): Promise<PlannedAction[]>;
}

/** The empty observation handed to `decide()` for lane-gated (terminal/`todo`) cards. */
const EMPTY_OBS: Observation = { result: null, review: null, alive: false, merged: false };

/**
 * Construct the reconcile loop from injected ports. This is the **composition
 * root** — the only place the shell knows the concrete ports; everything below is
 * driven through the port interfaces, so the same loop runs against Fakes (tests)
 * or real adapters with no change.
 */
export function createLoop(ports: LoopPorts, config: LoopConfig): Loop {
  const dryRun = config.dryRun ?? false;
  const shouldGiveUp = config.shouldGiveUp ?? guardrails;
  const overrideBudget = config.promotionBudget;
  const fleetOpts: FleetOptions = {
    cap: config.concurrencyCap,
    dailySpendCeiling: config.dailySpendCeiling ?? FLEET_DEFAULTS.dailySpendCeiling,
    breakerWindow: config.breakerWindow ?? FLEET_DEFAULTS.breakerWindow,
    breakerThreshold: config.breakerThreshold ?? FLEET_DEFAULTS.breakerThreshold,
    breakerMinSamples: config.breakerMinSamples ?? FLEET_DEFAULTS.breakerMinSamples,
    spendWindowMs: config.spendWindowMs ?? FLEET_DEFAULTS.spendWindowMs,
  };
  // Rising-edge debounce for breaker_open. Not essential state: a lost flag costs
  // one extra audit line, never correctness (budget is recomputed every tick).
  let breakerWasOpen = false;

  /** Gather the cheap, side-effect-free {@link Observation} for a card. */
  async function observe(card: Card): Promise<Observation> {
    const [result, review, alive, merged, diff] = await Promise.all([
      ports.runtime.readResult(card),
      ports.runtime.readReview(card),
      ports.runtime.isAlive(card),
      ports.git.isMerged(card),
      ports.git.diff(card),
    ]);
    const obs: Observation = { result, review, alive, merged };
    // Absent diffHash ⇒ empty diff (the "done but changed nothing" signal).
    if (diff.length > 0) obs.diffHash = hashString(diff);
    return obs;
  }

  /**
   * Perform one action's effect and fold its result into the working journal.
   * Returns the (possibly new) journal; never mutates the input in place.
   */
  async function applyAction(
    action: Action,
    card: Card,
    policy: CardPolicy,
    obs: Observation,
    journal: CardJournal,
    now: number,
    actionId: string,
  ): Promise<CardJournal> {
    switch (action.kind) {
      case "NoOp":
        return journal;

      case "LaunchProducer":
        // Default in-band adapter no-ops (the MoveLane triggered dev-3.0's spawn);
        // out-of-band adapters carry the real launch.
        await ports.runtime.launchProducer(card, policy.implementor, card.prompt);
        return journal;

      case "LaunchGrader":
        await ports.runtime.launchGrader(card, policy.reviewer, graderPrompt(card));
        return journal;

      case "RunChecks": {
        // The source of truth for green/red — never the implementor's self-report.
        const result = await ports.git.runChecks(card, policy.checksCmd);
        return foldCheck(journal, result, obs, now);
      }

      case "SendFixPrompt":
        await ports.runtime.sendFixPrompt(card, action.findings);
        return foldFixPrompt(journal, obs, now);

      case "MoveLane":
        await ports.board.moveCard(card.id, action.to, action.expect);
        if (action.note !== undefined) await ports.board.addNote(card.id, action.note);
        return journal;

      case "Merge": {
        // Idempotent + exactly-once: the adapter no-ops if already merged. The
        // write-ahead `pending` marker set before this ran is cleared on success
        // (recovery re-verifies any marker still present after a crash).
        const result = await ports.git.merge(card);
        const cleared = clearPending(journal, actionId);
        return result.merged ? { ...cleared, terminal: "merged" } : cleared;
      }

      case "OpenPr":
        await ports.git.openPr(card);
        return { ...clearPending(journal, actionId), terminal: "pr_opened" };

      case "GiveUp":
        // Abandon to the human: move to user-questions + a diagnostic note, leave
        // the worktree intact.
        await ports.board.moveCard(card.id, "user-questions");
        await ports.board.addNote(card.id, giveUpNote(action.reason, journal));
        return { ...journal, terminal: "given_up" };

      default:
        return assertNever(action);
    }
  }

  async function tick(): Promise<PlannedAction[]> {
    const now = ports.clock.now();
    const cards = await ports.board.listCards();
    const journals = await ports.journal.loadAll();

    // Fleet gate: computed ONCE per tick, consumed sequentially. An override is a
    // concurrency-only counter; otherwise the full evaluateFleet policy applies.
    const decision: FleetDecision = overrideBudget
      ? { budget: overrideBudget(cards, journals), breakerOpen: false }
      : evaluateFleet(cards, journals, fleetOpts, now);
    let slots = decision.budget;

    if (decision.breakerOpen && !breakerWasOpen && !dryRun) {
      await ports.eventLog.append(breakerEvent(now, decision)); // rising edge only
    }
    breakerWasOpen = decision.breakerOpen;

    const planned: PlannedAction[] = [];

    for (const card of cards) {
      const policy = await ports.config.policyFor(card);
      let journal = journals[card.id] ?? freshJournal(card.id);
      const key = routingKey(card);

      // Human edits are authoritative inputs (level-triggered):
      // a card the human dragged from user-questions back to in-progress is a
      // deliberate revive — reset consecutiveFailures and clear `terminal` so it is
      // no longer flagged `given_up`. Preserves the absolute attempt history.
      if (key === "in-progress" && journal.terminal === "given_up") {
        journal = applyHumanResume(journal);
        if (!dryRun) await ports.journal.persist(journal);
      }

      const obs = needsObservation(key, journal) ? await observe(card) : EMPTY_OBS;
      const actions = decide(card, journal, policy, obs, now, shouldGiveUp);

      let actionIndex = 0;
      for (const action of actions) {
        if (action.kind === "NoOp") continue;

        const promotion = isPromotion(action);
        if (promotion && slots <= 0) {
          // Fleet gate: hold this promotion (and its bound LaunchProducer) this
          // tick; the card stays in `todo` and is re-derived next tick.
          if (dryRun) planned.push({ cardId: card.id, action, gated: true });
          break;
        }

        planned.push({ cardId: card.id, action });

        if (dryRun) {
          // Reflect the gate in the plan, but mutate NOTHING.
          if (promotion) slots -= 1;
          actionIndex += 1;
          continue;
        }

        // Per-action write-ahead: (pending →) intent → execute+fold → persist → done.
        const actionId = `${card.id}:${action.kind}:${now}:${actionIndex}`;
        actionIndex += 1;
        const detail = eventDetail(action);

        // Irreversible effects (Merge/OpenPr) get a JOURNAL-side write-ahead marker
        // persisted BEFORE they run, so a crash between here and `done` leaves a
        // `pending` entry that recovery reality-checks (never blind-retries). Other
        // actions are idempotent / CAS-guarded and need no marker.
        if (isIrreversible(action)) {
          journal = withPending(journal, actionId, action.kind, now);
          await ports.journal.persist(journal);
        }

        await ports.eventLog.append(mkEvent("intent", now, card.id, action.kind, actionId, detail));
        journal = await applyAction(action, card, policy, obs, journal, now, actionId);
        if (promotion) slots -= 1;
        await ports.journal.persist(journal);
        await ports.eventLog.append(mkEvent("done", now, card.id, action.kind, actionId, detail));
      }
    }

    return planned;
  }

  return { tick };
}

// --- interval runner ------------------------------------------------------

/** Options for {@link runLoop} — the level-triggered interval driver. */
export interface RunnerOptions {
  /** Period between ticks, in ms (passed to {@link RunnerOptions.sleep}). */
  intervalMs: number;
  /** Injected sleep so the runner is testable without real timers. */
  sleep: (ms: number) => Promise<void>;
  /** Stop after this many ticks (tests / bounded runs); unbounded when omitted. */
  maxTicks?: number;
  /** Polled before each tick + before each sleep; return true to stop the loop. */
  shouldStop?: () => boolean;
  /** Called after every tick with that tick's plan (e.g. dry-run logging). */
  onTick?: (planned: PlannedAction[], tickNumber: number) => void;
}

/**
 * Drive {@link Loop.tick} on an interval. Level-triggered: every tick is
 * a full reconcile that re-derives all actions from durable state, so a missed
 * wake-up never causes divergence. The clock/sleep are injected so this is fully
 * testable without real timers. Returns the number of ticks executed.
 */
export async function runLoop(loop: Loop, opts: RunnerOptions): Promise<number> {
  let ticks = 0;
  while (true) {
    if (opts.shouldStop?.()) break;
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;

    const planned = await loop.tick();
    ticks += 1;
    opts.onTick?.(planned, ticks);

    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;
    if (opts.shouldStop?.()) break;
    await opts.sleep(opts.intervalMs);
  }
  return ticks;
}

/**
 * The named composition entrypoint the CLI's `run`/`dry-run` will call once the
 * real adapters land: build the loop from injected ports and drive it on an
 * interval, logging the intended actions each tick in dry-run. Kept here (not in
 * `cli.ts`) so the wiring is one swap-in away from real I/O.
 */
export async function startReconciler(
  ports: LoopPorts,
  config: LoopConfig & { intervalMs: number },
  opts: Omit<RunnerOptions, "intervalMs" | "onTick"> & {
    log?: (line: string) => void;
  } = { sleep: defaultSleep },
): Promise<number> {
  const loop = createLoop(ports, config);
  const dryRun = config.dryRun ?? false;
  const log = opts.log;
  // Reality-check any write-ahead markers a prior crash left, BEFORE the first
  // tick (so an in-flight Merge is reconciled, never blind-retried). Skipped in
  // dry-run, which must mutate nothing.
  if (!dryRun) {
    const report = await recover(ports);
    if (log && report.recovered.length > 0) {
      for (const m of report.recovered) {
        log(`[recover] ${m.cardId} ${m.kind} (${m.actionId}) → ${m.resolution}`);
      }
    }
  }
  const runnerOpts: RunnerOptions = {
    intervalMs: config.intervalMs,
    sleep: opts.sleep ?? defaultSleep,
  };
  if (opts.maxTicks !== undefined) runnerOpts.maxTicks = opts.maxTicks;
  if (opts.shouldStop !== undefined) runnerOpts.shouldStop = opts.shouldStop;
  if (dryRun && log) {
    runnerOpts.onTick = (planned, n) => {
      for (const p of planned) {
        log(`[dry-run tick ${n}] ${p.cardId} → ${describeAction(p.action)}${p.gated ? " (gated)" : ""}`);
      }
    };
  }
  return runLoop(loop, runnerOpts);
}

// --- pure helpers ---------------------------------------------------------

/**
 * Lane-gating: only cards being actively worked need the full cheap-read
 * snapshot. `todo` / observe-only terminal / journaled-terminal cards route off
 * the key alone, so we skip the reads (and never blind-probe tmux).
 */
function needsObservation(key: Lane | CustomColumnId, journal: CardJournal): boolean {
  if (journal.terminal !== undefined) return false;
  return key !== "todo" && key !== "completed" && key !== "cancelled";
}

/**
 * A promotion = the `MoveLane → in-progress` emitted for a `todo` card (its
 * `expect` is `todo`). This is the only move the fleet gate counts; an
 * active→active re-entry (reviewer bounce, `expect` = a review lane) is not.
 */
function isPromotion(action: Action): boolean {
  return action.kind === "MoveLane" && action.to === "in-progress" && action.expect === "todo";
}

/** A fresh, never-attempted journal for a card the loadAll() snapshot didn't have. */
function freshJournal(cardId: string): CardJournal {
  return { cardId, attempts: [], consecutiveFailures: 0, totalTokens: 0, pending: {} };
}

/**
 * The irreversible, exactly-once effects: a botched retry can't be undone, so they
 * get a journal-side write-ahead `pending` marker and a recovery reality-check.
 * `MoveLane`/`RunChecks`/`SendFixPrompt`/launches are safe to repeat (CAS-guarded
 * or idempotent), so they don't.
 */
function isIrreversible(action: Action): boolean {
  return action.kind === "Merge" || action.kind === "OpenPr";
}

/** Add a write-ahead `pending` marker (new journal; never mutates the input). */
function withPending(journal: CardJournal, actionId: string, kind: string, now: number): CardJournal {
  return { ...journal, pending: { ...journal.pending, [actionId]: { kind, startedAt: now } } };
}

/** Clear a resolved write-ahead marker (new journal; no-op if it's already gone). */
function clearPending(journal: CardJournal, actionId: string): CardJournal {
  if (!(actionId in journal.pending)) return journal;
  const pending = { ...journal.pending };
  delete pending[actionId];
  return { ...journal, pending };
}

/**
 * Build a {@link LoopEvent}, attaching `detail` only when present (the schema uses
 * `exactOptionalPropertyTypes`, so an explicit `undefined` is not allowed).
 */
function mkEvent(
  type: "intent" | "done",
  ts: number,
  cardId: string,
  action: Action["kind"],
  actionId: string,
  detail: Record<string, unknown> | undefined,
): LoopEvent {
  const event: LoopEvent = { ts, cardId, type, action, actionId };
  if (detail !== undefined) event.detail = detail;
  return event;
}

/** Sentinel cardId for fleet-wide events (LoopEvent.cardId is required). */
const FLEET_CARD_ID = "*fleet*";

function breakerEvent(now: number, decision: FleetDecision): LoopEvent {
  return {
    ts: now,
    cardId: FLEET_CARD_ID,
    type: "breaker_open",
    detail: { failRate: decision.failRate, windowSize: decision.windowSize },
  };
}

/**
 * Structured detail for the audit trace. We keep a single `intent`/`done` event
 * stream (no dedicated `lane_move`/`guardrail_trip` records) and let `replay`
 * classify by `action` kind — so a `MoveLane` event carries its target/guard and a
 * `GiveUp` event carries its reason, which is all the timeline needs to render
 * lane moves and guardrail trips.
 */
function eventDetail(action: Action): Record<string, unknown> | undefined {
  switch (action.kind) {
    case "MoveLane": {
      const detail: Record<string, unknown> = { to: action.to };
      if (action.expect !== undefined) detail.expect = action.expect;
      if (action.note !== undefined) detail.note = action.note;
      return detail;
    }
    case "GiveUp":
      return { reason: action.reason };
    default:
      return undefined;
  }
}

/**
 * Fold a `RunChecks` {@link CheckResult} into a new {@link AttemptRecord} (happy
 * path). Green resets `consecutiveFailures`; red increments it (feeding the
 * caps the next tick reads back). The diff hash is recorded for edge-detection
 * + oscillation; the failure signature (best-effort) for no-progress detection.
 */
function foldCheck(
  journal: CardJournal,
  result: CheckResult,
  obs: Observation,
  now: number,
): CardJournal {
  const attempt: AttemptRecord = {
    n: journal.attempts.length + 1,
    outcome: result.passed ? "green" : "red",
    startedAt: now,
    endedAt: now,
  };
  if (obs.diffHash !== undefined) attempt.diffHash = obs.diffHash;
  if (!result.passed && result.failingTests && result.failingTests.length > 0) {
    attempt.failureSignature = hashString([...result.failingTests].sort().join("\n"));
  }
  return {
    ...journal,
    attempts: [...journal.attempts, attempt],
    consecutiveFailures: result.passed ? 0 : journal.consecutiveFailures + 1,
  };
}

/**
 * Fold a `SendFixPrompt` dispatch. Two shapes, distinguished by the journal:
 *  - **mechanical-red path** — the red attempt already exists (a prior `RunChecks`
 *    folded it); we just set `fixPromptSent` on it (exactly-once delivery).
 *  - **reviewer-rejection bounce** — the head's last attempt is *green* (it passed
 *    checks), so a `changes_requested` verdict is a NEW failure: fold a fresh
 *    **red** attempt (it feeds `consecutiveFailures` + the breaker) with
 *    `fixPromptSent` already set.
 */
function foldFixPrompt(journal: CardJournal, obs: Observation, now: number): CardJournal {
  const last = journal.attempts[journal.attempts.length - 1];
  if (last && last.outcome === "red" && last.fixPromptSent !== true) {
    const attempts = journal.attempts.slice(0, -1);
    attempts.push({ ...last, fixPromptSent: true });
    return { ...journal, attempts };
  }
  const attempt: AttemptRecord = {
    n: journal.attempts.length + 1,
    outcome: "red",
    startedAt: now,
    endedAt: now,
    fixPromptSent: true,
  };
  if (obs.diffHash !== undefined) attempt.diffHash = obs.diffHash;
  if (obs.review && obs.review.blocking.length > 0) {
    attempt.failureSignature = hashString([...obs.review.blocking].sort().join("\n"));
  }
  return {
    ...journal,
    attempts: [...journal.attempts, attempt],
    consecutiveFailures: journal.consecutiveFailures + 1,
  };
}

/** The reviewer's launch input (placeholder; the adversarial rubric lands later). */
function graderPrompt(card: Card): string {
  return card.acceptanceCriteria.length > 0 ? card.acceptanceCriteria.join("\n") : card.prompt;
}

/** Human-facing diagnostic attached to the board on give-up. */
function giveUpNote(reason: string, journal: CardJournal): string {
  return (
    `dev3-loop gave up: ${reason} ` +
    `(after ${journal.attempts.length} attempt(s), ${journal.consecutiveFailures} consecutive failure(s)).`
  );
}

/** One-line human description of an action (dry-run logging). */
function describeAction(action: Action): string {
  switch (action.kind) {
    case "MoveLane":
      return `MoveLane → ${action.to}${action.expect ? ` (expect ${action.expect})` : ""}`;
    case "GiveUp":
      return `GiveUp(${action.reason})`;
    default:
      return action.kind;
  }
}

/**
 * Stable 32-bit FNV-1a hash, hex. Used for the diff hash (edge-detection +
 * oscillation) and the failure signature. Deterministic and dependency-free.
 */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Default real sleep for the interval runner (replaced by an injected sleep in tests). */
declare const setTimeout: (cb: () => void, ms: number) => unknown;
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Exhaustiveness guard: a `never` here means an {@link Action} variant is unhandled. */
function assertNever(x: never): never {
  throw new Error(`unreachable action: ${JSON.stringify(x)}`);
}
