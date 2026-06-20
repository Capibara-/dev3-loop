/**
 * Settable {@link ClockPort} for tests (PLAN §5/§13). The pure domain reads time
 * only through this seam, so stall/heartbeat/timestamp logic is deterministic.
 *
 * @module adapters/fake/clock
 */

import type { ClockPort } from "../../ports/clock.ts";

/** A clock whose `now()` is fixed until explicitly set or advanced. */
export class FixedClock implements ClockPort {
  private current: number;

  constructor(now = 0) {
    this.current = now;
  }

  now(): number {
    return this.current;
  }

  /** Set the current time (epoch ms). */
  set(now: number): void {
    this.current = now;
  }

  /** Advance the clock by `ms` and return the new time. */
  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}
