/**
 * Per-card give-up guardrails — pure predicates.
 *
 * PURE module: no I/O, no adapter imports. {@link guardrails} is the real
 * {@link GiveUpPredicate} the loop injects into {@link decide} (which itself
 * defaults to the never-give-up `allowAll` stub, so the pure `decide` unit tests
 * stay decoupled from this policy). Evaluated before any fix re-prompt and while a
 * card is still working; the first predicate to trip wins and its `reason` is
 * recorded on the resulting `GiveUp` action + the board note.
 *
 * The six predicates, in fixed precedence:
 *  1. **consecutive-failure cap** — `consecutiveFailures >= maxConsecutiveFailures`.
 *  2. **absolute-iteration cap** — `attempts.length >= maxTotalAttempts`.
 *  3. **no-progress** — the last `K=2` red attempts share the same (defined)
 *     `failureSignature` (flailing on the identical failure).
 *  4. **oscillation** — a `diffHash` recurs after a *different* diff intervened
 *     (cycling between states).
 *  5. **stall** — `now - heartbeat > stallMs`.
 *  6. **per-card budget** — `totalTokens > tokenBudget`.
 *
 * **Graceful degradation is load-bearing** (§7 Finding #11a): a missing
 * `failureSignature` never trips *or* skips #3 (it just doesn't fire — we lean on
 * the always-present caps + oscillation); a missing heartbeat never trips #5; an
 * unset `tokenBudget` keeps #6 inert (it stays inert in production until the M4
 * usage adapter feeds `totalTokens`/`tokensSpent`).
 *
 * @module domain/guardrails
 */

import type { AttemptRecord, CardJournal, CardPolicy } from "./types.ts";
import type { Observation } from "../ports/dto.ts";
import type { GiveUpPredicate, GiveUpVerdict } from "./reconcile.ts";

/** Window for the no-progress predicate: the last K red attempts. */
const NO_PROGRESS_K = 2;

/** Stable reason strings recorded on the `GiveUp` action + board note. */
export type GiveUpReason =
  | "consecutive-failures"
  | "max-attempts"
  | "no-progress"
  | "oscillation"
  | "stall"
  | "budget";

function stop(reason: GiveUpReason): GiveUpVerdict {
  return { stop: true, reason };
}

const CONTINUE: GiveUpVerdict = { stop: false };

/**
 * No-progress: the last {@link NO_PROGRESS_K} **red** attempts carry the same
 * **defined** `failureSignature`. A `undefined` signature on the most recent red
 * makes this not fire (degrades gracefully — never trips on garbage, never skips
 * give-up on absence; the caps still apply).
 */
function noProgress(attempts: readonly AttemptRecord[]): boolean {
  const reds = attempts.filter((a) => a.outcome === "red");
  if (reds.length < NO_PROGRESS_K) return false;
  const recent = reds.slice(-NO_PROGRESS_K);
  const sig = recent[recent.length - 1]!.failureSignature;
  if (sig === undefined) return false;
  return recent.every((a) => a.failureSignature === sig);
}

/**
 * Oscillation: a `diffHash` returns *after a different diff intervened* — i.e. the
 * worktree cycled back to an earlier state. Consecutive identical hashes are
 * **not** oscillation: that is the same head evaluated twice (e.g. a green
 * `RunChecks` then the reviewer's `changes_requested` red, both folded over the
 * same diff), which is normal. So we collapse runs of identical consecutive
 * hashes first, then look for any repeat in the collapsed sequence:
 * `[X, X, Y, X]` → `[X, Y, X]` → repeat ⇒ oscillation; `[X, X]` → `[X]` ⇒ no.
 */
function oscillation(attempts: readonly AttemptRecord[]): boolean {
  const hashes = attempts
    .map((a) => a.diffHash)
    .filter((h): h is string => h !== undefined);
  const collapsed: string[] = [];
  for (const h of hashes) {
    if (collapsed[collapsed.length - 1] !== h) collapsed.push(h);
  }
  const seen = new Set<string>();
  for (const h of collapsed) {
    if (seen.has(h)) return true;
    seen.add(h);
  }
  return false;
}

/**
 * The real guardrail give-up predicate (§7). Pure: derives everything from the
 * durable journal + policy + the cheap {@link Observation} snapshot + `now`, with
 * no I/O. Returns the first tripped predicate's verdict, or `{ stop: false }`.
 */
export const guardrails: GiveUpPredicate = (
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
): GiveUpVerdict => {
  // 1. Consecutive-failure cap.
  if (journal.consecutiveFailures >= policy.maxConsecutiveFailures) {
    return stop("consecutive-failures");
  }
  // 2. Absolute-iteration cap.
  if (journal.attempts.length >= policy.maxTotalAttempts) {
    return stop("max-attempts");
  }
  // 3. No-progress (best-effort failure signature; tolerates undefined).
  if (noProgress(journal.attempts)) {
    return stop("no-progress");
  }
  // 4. Oscillation (diff hash cycled back).
  if (oscillation(journal.attempts)) {
    return stop("oscillation");
  }
  // 5. Stall — freshest known activity: this tick's observed heartbeat, else the
  //    journaled one. Absent ⇒ no baseline ⇒ never trips (degrades gracefully).
  const heartbeat = obs.heartbeatAt ?? journal.lastHeartbeatAt;
  if (heartbeat !== undefined && now - heartbeat > policy.stallMs) {
    return stop("stall");
  }
  // 6. Per-card token budget (inert until a usage adapter records spend).
  if (policy.tokenBudget !== undefined && journal.totalTokens > policy.tokenBudget) {
    return stop("budget");
  }
  return CONTINUE;
};
