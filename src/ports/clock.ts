// The clock seam. Injected so the pure domain (stall/heartbeat/timestamps) is deterministically
// testable with a FixedClock — the domain never reads the wall clock directly.

export interface ClockPort {
  now(): number; // epoch ms
}
