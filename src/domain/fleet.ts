// Fleet-level promotion policy — pure. The shell computes this once per tick and spends
// the returned budget sequentially across cards.

import type { AttemptRecord, Card, CardJournal } from "./types.ts";
import { routingKey } from "./reconcile.ts";

export interface FleetOptions {
  cap: number;
  dailySpendCeiling: number; // Infinity ⇒ no ceiling
  breakerWindow: number;
  breakerThreshold: number; // fraction, e.g. 0.5 = >50%
  breakerMinSamples: number;
  spendWindowMs: number;
}

/** What forced the budget to zero (for the breaker event / observability). */
export type FleetCause = "spend-ceiling" | "breaker";

export interface FleetDecision {
  budget: number;
  breakerOpen: boolean;
  cause?: FleetCause;
  failRate?: number;
  windowSize?: number;
}

/** Cards occupying a fleet slot: not `todo`, not terminal (observe-only or journaled). */
export function liveCount(
  cards: readonly Card[],
  journals: Readonly<Record<string, CardJournal>>,
): number {
  let live = 0;
  for (const card of cards) {
    if (journals[card.id]?.terminal !== undefined) continue;
    const key = routingKey(card);
    if (key !== "todo" && key !== "completed" && key !== "cancelled") live += 1;
  }
  return live;
}

function allAttempts(journals: Readonly<Record<string, CardJournal>>): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const j of Object.values(journals)) out.push(...j.attempts);
  return out;
}

function rollingSpend(attempts: readonly AttemptRecord[], now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  let sum = 0;
  for (const a of attempts) {
    if (a.tokensSpent !== undefined && a.startedAt > cutoff) sum += a.tokensSpent;
  }
  return sum;
}

interface BreakerResult {
  open: boolean;
  failRate: number;
  windowSize: number;
}

/** Non-green rate over the last N attempts (by startedAt). Failure = red/stalled/error. */
function evaluateBreaker(attempts: readonly AttemptRecord[], opts: FleetOptions): BreakerResult {
  const window = [...attempts].sort((a, b) => b.startedAt - a.startedAt).slice(0, opts.breakerWindow);
  const windowSize = window.length;
  // Cold-start floor: a normal first red (1-of-1 = 100%) must not freeze the fleet.
  if (windowSize < opts.breakerMinSamples) return { open: false, failRate: 0, windowSize };
  const failures = window.filter((a) => a.outcome !== "green").length;
  const failRate = failures / windowSize;
  return { open: failRate > opts.breakerThreshold, failRate, windowSize };
}

/**
 * Concurrency headroom, clamped to 0 by the spend ceiling or an open breaker. Pure:
 * the shell emits the breaker_open event from the returned decision.
 */
export function evaluateFleet(
  cards: readonly Card[],
  journals: Readonly<Record<string, CardJournal>>,
  opts: FleetOptions,
  now: number,
): FleetDecision {
  const attempts = allAttempts(journals);
  const breaker = evaluateBreaker(attempts, opts);
  const spendExceeded = rollingSpend(attempts, now, opts.spendWindowMs) > opts.dailySpendCeiling;

  let budget = Math.max(0, opts.cap - liveCount(cards, journals));
  let cause: FleetCause | undefined;
  if (spendExceeded) { budget = 0; cause = "spend-ceiling"; }
  if (breaker.open) { budget = 0; cause = "breaker"; } // breaker wins

  const decision: FleetDecision = { budget, breakerOpen: breaker.open };
  if (cause !== undefined) decision.cause = cause;
  if (breaker.open) {
    decision.failRate = breaker.failRate;
    decision.windowSize = breaker.windowSize;
  }
  return decision;
}
