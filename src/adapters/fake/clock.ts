// Settable ClockPort for tests — now() is fixed until explicitly set or advanced, so
// stall/heartbeat/timestamp logic is deterministic.

import type { ClockPort } from "../../ports/clock.ts";

export class FixedClock implements ClockPort {
  private current: number;

  constructor(now = 0) {
    this.current = now;
  }

  now(): number {
    return this.current;
  }

  set(now: number): void {
    this.current = now;
  }

  // Advance the clock by `ms` and return the new time.
  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}
