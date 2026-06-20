/**
 * The clock seam. Injected so the pure domain (stall/heartbeat/timestamps) is
 * deterministically testable with a `FixedClock` — the domain never reads the
 * wall clock directly (PLAN §5, §13).
 *
 * @module ports/clock
 */

/**
 * Supplies the current time to the domain.
 */
export interface ClockPort {
  /**
   * Current time as epoch milliseconds.
   *
   * @returns now, in ms since the Unix epoch.
   */
  now(): number;
}
