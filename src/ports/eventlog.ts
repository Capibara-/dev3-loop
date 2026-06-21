// The event-log seam: the append-only audit/observability trace (${stateDir}/events.ndjson,
// one JSON object per line). Powers `replay`; NOT a source of truth — the journal is
// authoritative and is not rebuilt from this.

import type { LoopEvent } from "./dto.ts";

export interface EventLogPort {
  // intent is written BEFORE an effectful action runs (write-ahead), done after it succeeds;
  // each must durably persist before the effect is treated as recorded.
  append(event: LoopEvent): Promise<void>;
}
