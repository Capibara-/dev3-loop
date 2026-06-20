/**
 * Data transfer objects exchanged across the {@link module:ports} seams.
 *
 * PURE module: types only. These describe (a) the results adapters hand back to
 * the domain ({@link CheckResult}, {@link MergeResult}, {@link PrResult}), (b) the
 * on-disk contracts the producer/grader agents write inside the worktree
 * ({@link ProducerResult} = `.dev3/result.json`, {@link GraderReview} =
 * `.dev3/review.json`), and (c) the replayable event-log record
 * ({@link LoopEvent}). Schemas mirror PLAN.md §10/§11.
 *
 * @module ports/dto
 */

import type { Action } from "../domain/types.ts";

/**
 * Outcome of running the mechanical checks command in a worktree
 * (`GitPort.runChecks`). This — never the producer's self-report — is the
 * source of truth for green/red (PLAN §2 #8, §13 test 2).
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
   * `failureSignature` used for no-progress detection (PLAN §10). Falls back to
   * `undefined` when no structured ids could be parsed.
   */
  failingTests?: string[];
}

/**
 * Outcome of a `GitPort.merge` of the card branch into its base.
 *
 * `alreadyMerged` makes the operation idempotent (PLAN §2 #4, §9): a write-ahead
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
 * The status file the **producer** agent writes on finish: `.dev3/result.json`
 * inside the worktree (PLAN §10). Its presence is the producer's "I'm done"
 * signal; `claimedTestsPass` is **never trusted** — the reconciler re-runs the
 * checks regardless (PLAN §13 test 2).
 */
export interface ProducerResult {
  /** `done` ⇒ ready for checks; `blocked` ⇒ needs human input. */
  status: "done" | "blocked";
  /** Short natural-language summary of what was done. */
  summary: string;
  /** The blocking question when `status === "blocked"`, else `null`. */
  blockedQuestion: string | null;
  /** The agent's (untrusted) claim that its tests pass. */
  claimedTestsPass: boolean;
}

/** A single per-criterion verdict line within a {@link GraderReview}. */
export interface GraderCriterion {
  /** The acceptance criterion being judged. */
  criterion: string;
  /** True iff the grader considers this criterion met. */
  met: boolean;
  /** The grader's rationale / evidence for the verdict. */
  note: string;
}

/**
 * The status file the independent **grader** agent writes: `.dev3/review.json`
 * inside the worktree (PLAN §8/§10). The `verdict` — not the board lane — drives
 * routing in `decide()`, because dev-3.0's on-exit hook may force-advance the
 * card before we read it (PLAN §6, DISCOVERY §Q5).
 */
export interface GraderReview {
  /** `pass` ⇒ proceed to the human gate; `changes_requested` ⇒ loop a fix. */
  verdict: "pass" | "changes_requested";
  /** Per-criterion breakdown. */
  criteria: GraderCriterion[];
  /** Blocking findings; non-empty iff `verdict === "changes_requested"`. */
  blocking: string[];
  /** True iff the grader re-ran the mechanical checks itself. */
  ranChecks: boolean;
}

/**
 * Phase of an effectful action's lifecycle, or a standalone observation, as
 * recorded in the append-only NDJSON event log (PLAN §9).
 *
 * - `intent` — written **before** an effectful action runs (write-ahead).
 * - `done`   — written **after** it succeeds; pairs with an `intent` by `actionId`.
 * - `lane_move`      — a board lane/column transition was issued.
 * - `guardrail_trip` — a guardrail predicate fired (give-up).
 * - `breaker_open`   — the fleet circuit breaker opened (PLAN §7).
 */
export type LoopEventType = "intent" | "done" | "lane_move" | "guardrail_trip" | "breaker_open";

/**
 * One record in the append-only event log (`${stateDir}/events.ndjson`). This is
 * an audit/observability trace (powers `replay` + the operations story) — **not**
 * a source of truth: the journal is authoritative and is **not** rebuilt from
 * these (PLAN §9, §13 test 10, Finding #10).
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
