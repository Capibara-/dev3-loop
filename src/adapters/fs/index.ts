// Barrel for the filesystem adapters: the durable side of the loop (journal + events.ndjson)
// plus the wall-clock — the persistence seam. The dev-3.0 / git / tmux adapters land later.

export { FsJournal } from "./journal.ts";
export { NdjsonEventLog } from "./eventlog.ts";
export { SystemClock } from "./clock.ts";
