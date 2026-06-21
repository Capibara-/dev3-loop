// The journal seam: durable per-card bookkeeping — the single source of truth for state. The
// orchestrator holds no essential state in RAM; counters, attempt history, spend, and
// write-ahead markers all live here so a crash + restart resumes correctly. (NOT rebuilt from
// the event log; the log is an audit trace only.) One JSON file per card under
// ${stateDir}/journal/<cardId>.json.

import type { CardJournal } from "../domain/types.ts";

export interface JournalPort {
  loadAll(): Promise<Record<string, CardJournal>>; // cardId → CardJournal (empty when none exist yet); called once per tick
  persist(j: CardJournal): Promise<void>; // atomic write (tmp + rename) so a crash never leaves a torn file
}
