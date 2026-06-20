/**
 * The reconcile state machine: `decide()` — the pure heart of dev3-loop.
 *
 * PURE module: no I/O, no adapter imports, no clock/fs/process access. Given the
 * card's observed state, our durable journal, the resolved policy, a per-tick
 * {@link Observation} snapshot, and the current time, it returns the single
 * {@link Action} the executor should perform this tick. It is exhaustively
 * unit-tested in T8 (one case per row of the PLAN §6 transition table).
 *
 * ## Why an {@link Observation} parameter?
 *
 * PLAN §6 routes on facts that only adapters can read — `result.json`,
 * `review.json`, session liveness, `git.isMerged`, the latest mechanical-check
 * outcome, and the fleet slot count. A *pure* function cannot perform that I/O,
 * so the impure tick loop gathers it once into an {@link Observation} and hands
 * it in. `decide()` then maps `(card, journal, policy, obs, now) → Action` with
 * zero side effects, which is exactly what makes the §6 table testable in
 * isolation (PLAN §3/§13).
 *
 * ## Single action per tick; executor performs coupled follow-ups
 *
 * `decide()` returns **one** {@link Action}. Several §6 transitions read as a
 * pair ("MoveLane → review-by-ai *then* LaunchGrader"); the executor encapsulates
 * the tightly-coupled follow-up so the domain stays single-valued and pure:
 *
 * - {@link Action} `LaunchGrader` ⇒ the adapter moves the card to `review-by-ai`
 *   (guarded) **and** spawns the independent grader (PLAN §8 — the move *is* the
 *   default grader-launch mechanism).
 * - {@link Action} `GiveUp` ⇒ the adapter moves the card to `user-questions`
 *   (guarded) **and** attaches the diagnostic note (PLAN §7).
 * - {@link Action} `SendFixPrompt` ⇒ when the card is still in a review lane the
 *   adapter first issues a guarded `--if-status <lane>` move back to
 *   `in-progress` (which also no-ops dev-3.0's on-exit auto-advance, DISCOVERY
 *   §Q5), then types the findings into the producer's pane. When the card is
 *   already `in-progress` (red mechanical checks) no move is needed.
 *
 * Every {@link Action} `MoveLane` that `decide()` *does* emit carries `expect`
 * (the lane we believe the card is in) so the adapter can issue a server-enforced
 * compare-and-set move (DISCOVERY §Q2-bis).
 *
 * @module domain/reconcile
 */

import type { Action, Card, CardJournal, CardPolicy } from "./types.ts";
import type { CheckResult, GraderReview, ProducerResult } from "../ports/dto.ts";

/**
 * The per-tick snapshot of everything `decide()` needs that only an adapter can
 * observe. Gathered once by the impure tick loop (cheap probes + file reads;
 * mechanical checks are an explicit {@link Action}, recorded back here as
 * {@link Observation.checks} on a subsequent tick) and passed to `decide()` so it
 * can stay pure.
 */
export interface Observation {
  /**
   * The producer's `.dev3/result.json`, or `null` if it has not written one yet.
   * Its *presence* is the producer's "done" signal; its `claimedTestsPass` flag
   * is never trusted — we re-run the checks regardless (PLAN §2 #8, §10).
   */
  result: ProducerResult | null;
  /**
   * The latest mechanical-check outcome for the current `result.json`, or `null`
   * when checks have not been run yet for it. This — not the producer's
   * self-report — is the source of truth for green/red.
   */
  checks: CheckResult | null;
  /**
   * The grader's `.dev3/review.json`, or `null` if the grader has not produced a
   * verdict yet. The **verdict drives routing**, not the lane, because dev-3.0's
   * on-exit hook may force-advance the card before we read it (PLAN §6, §Q5).
   */
  review: GraderReview | null;
  /** Whether the card's tmux session/pane is currently alive. */
  alive: boolean;
  /**
   * Whether the branch is already merged into base. The exactly-once guard for
   * {@link Action} `Merge` (PLAN §2 #4, §9).
   */
  merged: boolean;
  /**
   * Whether the fleet has a free slot to promote a `todo` card (PLAN §7). The
   * fleet/cap math is computed by the caller (M3) and surfaced here as a boolean;
   * `decide()` only reads it — it implements no cap logic itself.
   */
  slotFree: boolean;
}

/**
 * The outcome of a give-up evaluation: whether to abandon the card to the human,
 * and why. Mirrors the guardrail predicate of PLAN §7.
 */
export interface GiveUpDecision {
  /** True ⇒ stop the fix loop and give up (route to `user-questions`). */
  stop: boolean;
  /** Human-readable reason, surfaced in the board note when `stop` is true. */
  reason?: string;
}

/**
 * Injected guardrail predicate, evaluated before any fix re-prompt (PLAN §7).
 * The real implementation (consecutive-failure / total-attempt / no-progress /
 * oscillation / budget caps) arrives in M3; `decide()` never embeds that logic.
 */
export type GiveUpPredicate = (
  journal: CardJournal,
  policy: CardPolicy,
  now: number,
) => GiveUpDecision;

/**
 * Default give-up predicate: a stub that **never** trips, so the fix loop always
 * continues. The guardrail caps that would make it return `{ stop: true }` are
 * deliberately deferred to M3 (PLAN §7, §15); `decide()` is shipped against this
 * "allow" stub so the §6 routing can be tested independently of the caps.
 */
export const neverGiveUp: GiveUpPredicate = () => ({ stop: false });

const noop: Action = { kind: "NoOp" };

/**
 * Decide the single {@link Action} to perform for a card this tick. Pure: a
 * function only of its inputs, with no side effects.
 *
 * Routing key = the card's custom column when set, else its built-in lane
 * (PLAN §6). A set `customColumnId` is interpreted as the merge-trigger
 * ("ready_to_merge") column and dispatches on {@link CardPolicy.merge}.
 *
 * @param card        the observed card (read-only board projection).
 * @param journal     our durable per-card bookkeeping.
 * @param policy      the resolved per-card policy (merge strategy, caps, agents).
 * @param obs         the per-tick {@link Observation} snapshot gathered by the loop.
 * @param now         current epoch ms (from `ClockPort.now`), used for stall math.
 * @param shouldGiveUp injected guardrail predicate; defaults to {@link neverGiveUp}
 *                     (caps are M3 — see {@link GiveUpPredicate}).
 * @returns the {@link Action} the executor should perform (possibly `NoOp`).
 */
export function decide(
  card: Card,
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
  shouldGiveUp: GiveUpPredicate = neverGiveUp,
): Action {
  // Terminal for the loop (merged / pr_opened / given_up / cancelled): never
  // reconcile again. Idempotency + exactly-once rest on this (PLAN §9).
  if (journal.terminal) return noop;

  // A set custom column overrides the (now-stale) built-in lane for routing and
  // means "human signalled merge" — dispatch the merge policy (PLAN §6).
  if (card.customColumnId) return decideMergeTrigger(card, journal, policy, obs);

  switch (card.lane) {
    case "todo":
      // Promote only while the fleet has a slot; the move makes dev-3.0 spawn the
      // worktree+session. `expect` guards the compare-and-set move.
      return obs.slotFree
        ? { kind: "MoveLane", card, to: "in-progress", expect: "todo" }
        : noop;

    case "in-progress":
      return decideInProgress(card, journal, policy, obs, now, shouldGiveUp);

    // Verdict-driven: route from BOTH review lanes because dev-3.0's on-exit hook
    // may have already nudged the card `review-by-ai → review-by-user` (§Q5).
    case "review-by-ai":
    case "review-by-user":
      return decideReview(card, journal, policy, obs, now, shouldGiveUp);

    case "user-questions":
      // Parked for the human (blocked, or our give-up lane). A human dragging the
      // card back to in-progress is the resume signal (the loop resets
      // consecutiveFailures, not totalAttempts, on that transition — PLAN §6);
      // while it sits here we wait.
      return noop;

    case "review-by-colleague":
      // "PR Review" lane == the open_pr outcome: ensure a PR exists, then park.
      // After OpenPr the executor sets `terminal = "pr_opened"` → the top guard
      // NoOps on later ticks (idempotent).
      return { kind: "OpenPr", card };

    case "completed":
    case "cancelled":
      // Observe-only terminal states (UI destroys the worktree); never written by
      // us, never reconciled.
      return noop;
  }
}

/**
 * `in-progress` routing (PLAN §6): producer lifecycle + mechanical checks. The
 * producer's self-report is never trusted — `result.json` only triggers checks.
 */
function decideInProgress(
  card: Card,
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
  shouldGiveUp: GiveUpPredicate,
): Action {
  if (!obs.result) {
    // No completion signal yet.
    if (journal.lastHeartbeatAt == null) {
      // Just promoted; producer not launched yet (idempotent if already running).
      return { kind: "LaunchProducer", card };
    }
    if (!obs.alive || now - journal.lastHeartbeatAt > policy.stallMs) {
      // Session died, or no heartbeat within stallMs → hung. Hand to the human.
      return { kind: "GiveUp", card, reason: "stall" };
    }
    return noop; // still working
  }

  // result.json present — re-run the checks; never trust `claimedTestsPass`.
  if (obs.checks == null) return { kind: "RunChecks", card };

  if (obs.checks.passed) {
    // Green → grade. The grader-launch adapter performs the guarded move to
    // review-by-ai with its overridden config (PLAN §8); we never grade
    // non-compiling output.
    return { kind: "LaunchGrader", card };
  }

  // Red → loop a fix, unless a guardrail cap trips (M3 predicate).
  const gu = shouldGiveUp(journal, policy, now);
  if (gu.stop) return { kind: "GiveUp", card, reason: gu.reason ?? "guardrail" };
  return { kind: "SendFixPrompt", card, findings: checkFindings(obs.checks) };
}

/**
 * `review-by-ai` / `review-by-user` routing (PLAN §6/§8). The grader's verdict —
 * not the lane — is authoritative, so both lanes share this logic.
 */
function decideReview(
  card: Card,
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
  shouldGiveUp: GiveUpPredicate,
): Action {
  if (!obs.review) return noop; // grader still running (no verdict yet)

  if (obs.review.verdict === "pass") {
    // Let the human gate hold. From review-by-ai, advance to the gate (guarded);
    // if dev-3.0's hook already advanced us to review-by-user, just wait.
    if (card.lane === "review-by-ai") {
      return { kind: "MoveLane", card, to: "review-by-user", expect: "review-by-ai" };
    }
    return noop; // review-by-user + pass → human gate
  }

  // changes_requested → route findings back to the producer, unless a cap trips.
  // The executor guard-moves the card back to in-progress (--if-status <lane>),
  // which also neutralizes dev-3.0's on-exit auto-advance (§Q5).
  const gu = shouldGiveUp(journal, policy, now);
  if (gu.stop) return { kind: "GiveUp", card, reason: gu.reason ?? "guardrail" };
  return { kind: "SendFixPrompt", card, findings: reviewFindings(obs.review) };
}

/**
 * Merge-trigger (custom-column) dispatch at the human gate (PLAN §6). Reaching
 * here means a human moved the card into the no-agent merge column. Merge runs
 * while the worktree is still alive; we never auto-`complete` (PLAN §6).
 */
function decideMergeTrigger(
  card: Card,
  _journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
): Action {
  if (obs.merged) return noop; // exactly-once: already merged

  switch (policy.merge) {
    case "open_pr":
      // Don't auto-merge: open the PR and leave the human to merge it.
      return { kind: "OpenPr", card };
    case "merge_when_green":
    case "fix_until_green_and_merge":
      // The card only reaches the merge column after the green + grader-pass
      // pipeline, so the green precondition is already satisfied.
      return { kind: "Merge", card };
  }
}

/** Build producer-facing fix findings from a failed {@link CheckResult}. */
function checkFindings(c: CheckResult): string {
  if (c.failingTests && c.failingTests.length > 0) {
    return `Mechanical checks failed. Failing tests:\n${c.failingTests.join("\n")}`;
  }
  const err = (c.stderr || c.stdout || "").trim();
  return err
    ? `Mechanical checks failed (exit ${c.exitCode}):\n${err}`
    : `Mechanical checks failed (exit ${c.exitCode}).`;
}

/** Build producer-facing fix findings from a `changes_requested` review. */
function reviewFindings(r: GraderReview): string {
  if (r.blocking.length > 0) {
    return `Grader requested changes:\n${r.blocking.join("\n")}`;
  }
  const unmet = r.criteria
    .filter((c) => !c.met)
    .map((c) => `- ${c.criterion}: ${c.note}`);
  return unmet.length > 0
    ? `Grader requested changes:\n${unmet.join("\n")}`
    : "Grader requested changes.";
}
