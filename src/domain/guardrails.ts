// Per-card give-up guardrails — pure. The real GiveUpPredicate the loop injects into
// decide() (which itself defaults to allowAll). First trip wins. Best-effort inputs
// (signature, heartbeat, tokenBudget) degrade gracefully: absence never trips and never
// skips give-up.

import type { AttemptRecord, CardJournal, CardPolicy } from "./types.ts";
import type { Observation } from "../ports/dto.ts";
import type { GiveUpPredicate, GiveUpVerdict } from "./reconcile.ts";

const NO_PROGRESS_K = 2;

/** Stable reason recorded on the GiveUp action + board note. */
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

/** Last K red attempts share a defined failureSignature (undefined ⇒ doesn't fire). */
function noProgress(attempts: readonly AttemptRecord[]): boolean {
  const reds = attempts.filter((a) => a.outcome === "red");
  if (reds.length < NO_PROGRESS_K) return false;
  const recent = reds.slice(-NO_PROGRESS_K);
  const sig = recent[recent.length - 1]!.failureSignature;
  return sig !== undefined && recent.every((a) => a.failureSignature === sig);
}

/**
 * Cycling: a diffHash returns *after a different diff intervened* — not merely seen
 * twice. Consecutive identical hashes are one head evaluated twice (a green
 * RunChecks then a reviewer changes_requested, both folded over the same diff) and
 * are normal, so collapse consecutive runs first: [X,X,Y,X] → [X,Y,X] → repeat.
 */
function oscillation(attempts: readonly AttemptRecord[]): boolean {
  const collapsed: string[] = [];
  for (const a of attempts) {
    if (a.diffHash !== undefined && collapsed[collapsed.length - 1] !== a.diffHash) {
      collapsed.push(a.diffHash);
    }
  }
  const seen = new Set<string>();
  for (const h of collapsed) {
    if (seen.has(h)) return true;
    seen.add(h);
  }
  return false;
}

export const guardrails: GiveUpPredicate = (
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
): GiveUpVerdict => {
  if (journal.consecutiveFailures >= policy.maxConsecutiveFailures) return stop("consecutive-failures");
  if (journal.attempts.length >= policy.maxTotalAttempts) return stop("max-attempts");
  if (noProgress(journal.attempts)) return stop("no-progress");
  if (oscillation(journal.attempts)) return stop("oscillation");

  const heartbeat = obs.heartbeatAt ?? journal.lastHeartbeatAt; // absent ⇒ no baseline ⇒ never trips
  if (heartbeat !== undefined && now - heartbeat > policy.stallMs) return stop("stall");

  if (policy.tokenBudget !== undefined && journal.totalTokens > policy.tokenBudget) return stop("budget");
  return CONTINUE;
};
