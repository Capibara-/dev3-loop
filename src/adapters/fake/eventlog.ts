// In-memory EventLogPort for tests — appends to a public array so tests can assert the
// write-ahead intent/done ordering.

import type { LoopEvent } from "../../ports/dto.ts";
import type { EventLogPort } from "../../ports/eventlog.ts";

export class FakeEventLog implements EventLogPort {
  readonly events: LoopEvent[] = []; // every appended event, in order

  append(event: LoopEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
