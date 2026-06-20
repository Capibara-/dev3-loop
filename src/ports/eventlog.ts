/**
 * The event-log seam: the append-only, replayable spine of the system. Every
 * intent/done pair, lane move, and guardrail trip is recorded here; the journal
 * is a projection rebuildable from it (PLAN §9).
 *
 * @module ports/eventlog
 */

import type { LoopEvent } from "./dto.ts";

/**
 * Appends {@link LoopEvent}s to the durable, append-only log
 * (`${stateDir}/events.ndjson`, one JSON object per line).
 */
export interface EventLogPort {
  /**
   * Append a single event. Must durably persist before the corresponding effect
   * is treated as recorded — `intent` is written **before** an effectful action
   * runs (write-ahead), `done` **after** it succeeds (PLAN §9).
   *
   * @param event the event to append.
   */
  append(event: LoopEvent): Promise<void>;
}
