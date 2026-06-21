/**
 * The real {@link ClockPort}: wall-clock epoch milliseconds.
 *
 * Tests use {@link module:adapters/fake/clock.FixedClock} instead so stall /
 * heartbeat / timestamp logic stays deterministic; production wires this.
 *
 * @module adapters/fs/clock
 */

import type { ClockPort } from "../../ports/clock.ts";

declare const Date: { now(): number };

/** Wall-clock clock backed by `Date.now()`. */
export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}
