/**
 * Fleet-level policy — pure (§7).
 *
 * PURE module: no I/O, no adapter imports. These are **cross-card** concerns the
 * shell computes in a once-per-tick pre-pass and enforces by spending the returned
 * promotion budget sequentially; `decide()` only ever *proposes* a promotion. A
 * per-card boolean would race (N `todo` cards all told "slot free" promote at once
 * and blow the cap), so the budget is a counter, never an `Observation` field.
 *
 * Three policies fold into one {@link FleetDecision}:
 *  - **Concurrency cap** — `budget = max(0, cap − liveCount)`.
 *  - **Daily-spend ceiling** — sum of `tokensSpent` over attempts started within
 *    the rolling `spendWindowMs` (default 24h) fleet-wide; over the ceiling forces
 *    `budget = 0` (stop promoting new cards; in-flight ones drain). Inert in
 *    production until the M4 usage adapter records `tokensSpent`.
 *  - **Circuit breaker** — over the last `breakerWindow` (N=10) completed attempts
 *    fleet-wide, if the **non-green** rate exceeds `breakerThreshold` (>50%) the
 *    breaker opens, forcing `budget = 0`. It only evaluates once at least
 *    `breakerMinSamples` (floor=4) attempts exist, so a normal early red (1-of-1)
 *    can't freeze the whole fleet — the breaker is a net for *correlated, systemic*
 *    failure (broken base branch / checksCmd, an outage, a bad agent config), not
 *    for one hard task (that is the per-card caps' job).
 *
 * The breaker must surface a `breaker_open` audit event, which is I/O — so this
 * module stays pure and returns the decision (incl. `failRate`/`windowSize` for the
 * event detail); the **shell** emits the event.
 *
 * @module domain/fleet
 */

import type { AttemptRecord, Card, CardJournal } from "./types.ts";
import { routingKey } from "./reconcile.ts";

/** Tunable fleet knobs (resolved from {@link GlobalConfig} + defaults by the shell). */
export interface FleetOptions {
  /** Live-card concurrency cap. */
  cap: number;
  /** Rolling-window spend ceiling; `Infinity` ⇒ no ceiling. */
  dailySpendCeiling: number;
  /** Breaker window: the last N completed attempts considered, fleet-wide. */
  breakerWindow: number;
  /** Breaker trip threshold as a fraction of non-green attempts (e.g. 0.5 = >50%). */
  breakerThreshold: number;
  /** Minimum attempts in the window before the breaker may open (cold-start floor). */
  breakerMinSamples: number;
  /** Rolling spend window in ms (default 24h). */
  spendWindowMs: number;
}

/** What forced the budget to zero (for observability / the breaker event). */
export type FleetCause = "spend-ceiling" | "breaker";

/** The once-per-tick fleet verdict the shell consumes. */
export interface FleetDecision {
  /** Promotion slots available this tick (consumed sequentially by the shell). */
  budget: number;
  /** True iff the circuit breaker is open. */
  breakerOpen: boolean;
  /** Set when a policy forced `budget = 0` (spend ceiling / breaker). */
  cause?: FleetCause;
  /** Non-green fraction over the breaker window (present iff the breaker opened). */
  failRate?: number;
  /** Number of attempts the breaker rate was computed over (present iff opened). */
  windowSize?: number;
}

/**
 * How many cards currently occupy a fleet slot: not `todo`, not an observe-only
 * terminal lane (`completed`/`cancelled`), and not journaled-terminal. Shared with
 * the shell's `concurrencyBudget` so both agree on liveness.
 */
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

/** Flatten every attempt across all journals into one list. */
function allAttempts(journals: Readonly<Record<string, CardJournal>>): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const j of Object.values(journals)) {
    for (const a of j.attempts) out.push(a);
  }
  return out;
}

/** Rolling-window spend: sum of `tokensSpent` for attempts started within the window. */
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

/**
 * Evaluate the circuit breaker over the last `breakerWindow` completed attempts
 * (ordered by `startedAt`, newest first). Non-green (`red`/`stalled`/`error`)
 * counts as failure. Stays closed until at least `breakerMinSamples` attempts
 * exist in the window.
 */
function evaluateBreaker(attempts: readonly AttemptRecord[], opts: FleetOptions): BreakerResult {
  const window = [...attempts].sort((a, b) => b.startedAt - a.startedAt).slice(0, opts.breakerWindow);
  const windowSize = window.length;
  if (windowSize < opts.breakerMinSamples) return { open: false, failRate: 0, windowSize };
  const failures = window.filter((a) => a.outcome !== "green").length;
  const failRate = failures / windowSize;
  return { open: failRate > opts.breakerThreshold, failRate, windowSize };
}

/**
 * Compute the fleet promotion budget for this tick: the concurrency headroom,
 * clamped to 0 when the daily-spend ceiling is exceeded or the circuit breaker is
 * open. Pure — the shell spends `budget` sequentially and emits the `breaker_open`
 * event when `breakerOpen` rises.
 */
export function evaluateFleet(
  cards: readonly Card[],
  journals: Readonly<Record<string, CardJournal>>,
  opts: FleetOptions,
  now: number,
): FleetDecision {
  const attempts = allAttempts(journals);
  const concurrency = Math.max(0, opts.cap - liveCount(cards, journals));
  const spendExceeded = rollingSpend(attempts, now, opts.spendWindowMs) > opts.dailySpendCeiling;
  const breaker = evaluateBreaker(attempts, opts);

  // Precedence for `budget = 0`: breaker (most severe) > spend ceiling > concurrency.
  let budget = concurrency;
  let cause: FleetCause | undefined;
  if (spendExceeded) {
    budget = 0;
    cause = "spend-ceiling";
  }
  if (breaker.open) {
    budget = 0;
    cause = "breaker";
  }

  const decision: FleetDecision = { budget, breakerOpen: breaker.open };
  if (cause !== undefined) decision.cause = cause;
  if (breaker.open) {
    decision.failRate = breaker.failRate;
    decision.windowSize = breaker.windowSize;
  }
  return decision;
}
