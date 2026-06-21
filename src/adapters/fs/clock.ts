// The real ClockPort: wall-clock epoch ms. Tests use FixedClock instead so stall/heartbeat/
// timestamp logic stays deterministic; production wires this.

import type { ClockPort } from "../../ports/clock.ts";

declare const Date: { now(): number };

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}
