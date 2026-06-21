/**
 * Data transfer objects exchanged across the {@link module:ports} seams.
 *
 * PURE module: types only. These describe (a) the results adapters hand back to
 * the domain ({@link CheckResult}, {@link MergeResult}, {@link PrResult}), (b) the
 * on-disk contracts the implementor/reviewer agents write inside the worktree
 * ({@link ImplementorResult} = `.dev3/result.json`, {@link Review} =
 * `.dev3/review.json`), and (c) the replayable event-log record
 * ({@link LoopEvent}).
 *
 * @module ports/dto
 */

import type { Action } from "../domain/types.ts";

/**
 * Outcome of running the mechanical checks command in a worktree
 * (`GitPort.runChecks`). This — never the implementor's self-report — is the
 * source of truth for green/red.
 */
export interface CheckResult {
  /** True iff the checks command exited 0. */
  passed: boolean;
  /** Process exit code (0 = green). */
  exitCode: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Wall-clock duration of the run, in ms. */
  durationMs: number;
  /**
   * Sorted failing-test ids when extractable; the stable hash of this set is the
   * `failureSignature` used for no-progress detection. Falls back to
   * `undefined` when no structured ids could be parsed.
   */
  failingTests?: string[];
}

/**
 * Outcome of a `GitPort.merge` of the card branch into its base.
 *
 * `alreadyMerged` makes the operation idempotent: a write-ahead
 * crash between intent and done is reconciled by re-checking, not blind retry.
 */
export interface MergeResult {
  /** True iff the branch is now merged into base (whether by this call or a prior one). */
  merged: boolean;
  /** True iff the branch was already merged before this call (exactly-once guard). */
  alreadyMerged: boolean;
  /** SHA of the resulting merge/HEAD commit on base, when known. */
  commit?: string;
  /** Human-readable detail (e.g. fast-forward vs no-ff, or failure reason). */
  message?: string;
}

/**
 * Outcome of a `GitPort.openPr` (the `gh` CLI) for the `open_pr` policy.
 *
 * `alreadyExisted` keeps PR creation idempotent across reconcile ticks.
 */
export interface PrResult {
  /** URL of the pull request. */
  url: string;
  /** PR number, when parseable from the `gh` output. */
  number?: number;
  /** True iff an open PR for this branch already existed (no new PR created). */
  alreadyExisted: boolean;
}

/**
 * The status file the **implementor** agent writes on finish: `.dev3/result.json`
 * inside the worktree. Its presence is the implementor's "I'm done"
 * signal; `claimedTestsPass` is **never trusted** — the reconciler re-runs the
 * checks regardless.
 */
export interface ImplementorResult {
  /** `done` ⇒ ready for checks; `blocked` ⇒ needs human input. */
  status: "done" | "blocked";
  /** Short natural-language summary of what was done. */
  summary: string;
  /** The blocking question when `status === "blocked"`, else `null`. */
  blockedQuestion: string | null;
  /** The agent's (untrusted) claim that its tests pass. */
  claimedTestsPass: boolean;
}

/** A single per-criterion verdict line within a {@link Review}. */
export interface ReviewCriterion {
  /** The acceptance criterion being judged. */
  criterion: string;
  /** True iff the reviewer considers this criterion met. */
  met: boolean;
  /** The reviewer's rationale / evidence for the verdict. */
  note: string;
}

/**
 * The status file the independent **reviewer** agent writes: `.dev3/review.json`
 * inside the worktree. The `verdict` — not the board lane — drives
 * routing in `decide()`, because dev-3.0's on-exit hook may force-advance the
 * card before we read it.
 */
export interface Review {
  /** `pass` ⇒ proceed to the human gate; `changes_requested` ⇒ loop a fix. */
  verdict: "pass" | "changes_requested";
  /** Per-criterion breakdown. */
  criteria: ReviewCriterion[];
  /** Blocking findings; non-empty iff `verdict === "changes_requested"`. */
  blocking: string[];
  /** True iff the reviewer re-ran the mechanical checks itself. */
  ranChecks: boolean;
}

/**
 * Phase of an effectful action's lifecycle, or a standalone observation, as
 * recorded in the append-only NDJSON event log.
 *
 * - `intent` — written **before** an effectful action runs (write-ahead).
 * - `done`   — written **after** it succeeds; pairs with an `intent` by `actionId`.
 * - `lane_move`      — a board lane/column transition was issued.
 * - `guardrail_trip` — a guardrail predicate fired (give-up).
 * - `breaker_open`   — the fleet circuit breaker opened.
 */
export type LoopEventType = "intent" | "done" | "lane_move" | "guardrail_trip" | "breaker_open";

/**
 * One record in the append-only event log (`${stateDir}/events.ndjson`). This is
 * an audit/observability trace (powers `replay` + the operations story) — **not**
 * a source of truth: the journal is authoritative and is **not** rebuilt from
 * these.
 */
export interface LoopEvent {
  /** Epoch ms when the event was emitted (from `ClockPort.now`). */
  ts: number;
  /** The card this event concerns. */
  cardId: string;
  /** Which lifecycle phase / observation this record captures. */
  type: LoopEventType;
  /** The {@link Action} kind this event relates to (for `intent`/`done`). */
  action?: Action["kind"];
  /**
   * Write-ahead action id correlating an `intent` with its matching `done`,
   * mirroring `CardJournal.pending` keys. Required for exactly-once merge.
   */
  actionId?: string;
  /** Free-form structured detail (reason, target lane, signature, spend, …). */
  detail?: Record<string, unknown>;
}

/**
 * The cheap, side-effect-free snapshot the imperative shell gathers each tick and
 * hands to the pure `decide()`. **Reads only** (idempotent): it never
 * runs the checks command and never mutates anything. Gathered **lane-gated** —
 * skip terminal/`todo` cards, never blind-probe tmux (`capture-pane` hangs on
 * control-mode sessions), and guard every read with a timeout.
 *
 * NOT here, on purpose:
 *  - the green/red check outcome — that is the journaled result of a `RunChecks`
 *    {@link Action} (folded into an `AttemptRecord` and read back by the next
 *    tick from `journal.attempts`), never a per-tick read;
 *  - fleet slot availability — a promotion budget the shell spends sequentially
 *    across cards, not a per-card field.
 *
 * Lives here (not in `domain/types.ts`) to avoid an import cycle: this module
 * already imports {@link Action} from there, and `reconcile.ts` imports this.
 */
export interface Observation {
  /** `.dev3/result.json` (implementor done-signal), or null if absent/unparseable. */
  result: ImplementorResult | null;
  /** `.dev3/review.json` (reviewer verdict), or null if absent/unparseable. */
  review: Review | null;
  /** Whether the card's tmux session/pane still exists. */
  alive: boolean;
  /** Whether the branch is already merged into base (exactly-once guard). */
  merged: boolean;
  /** Latest activity timestamp (terminal-preview delta / worktree mtime) — stall calc. */
  heartbeatAt?: number;
  /**
   * Hash of the current `base...branch` diff — the edge-detector that stops the
   * level-triggered loop re-firing on a *sticky* `result.json` plus
   * the oscillation signal. **Absent ⇒ an empty diff** (no changes
   * vs base): a present `result.json` over an absent `diffHash` is the degenerate
   * "done but changed nothing" → give up.
   */
  diffHash?: string;
}
