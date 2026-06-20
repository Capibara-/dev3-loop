/**
 * In-memory {@link EventLogPort} for tests (PLAN §5/§9). Appends to a public
 * array so tests can assert the write-ahead intent/done ordering of the
 * replayable spine.
 *
 * @module adapters/fake/eventlog
 */

import type { LoopEvent } from "../../ports/dto.ts";
import type { EventLogPort } from "../../ports/eventlog.ts";

/** In-memory, append-only event log backed by an array. */
export class FakeEventLog implements EventLogPort {
  /** Every appended event, in append order. */
  readonly events: LoopEvent[] = [];

  append(event: LoopEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
