/**
 * Barrel for the filesystem adapters: the durable side of the loop
 * (`${stateDir}/journal/<cardId>.json` + `${stateDir}/events.ndjson`) plus the
 * wall-clock. These are the persistence seam; the dev-3.0 / git / tmux adapters
 * land later.
 *
 * @module adapters/fs
 */

export { FsJournal } from "./journal.ts";
export { NdjsonEventLog } from "./eventlog.ts";
export { SystemClock } from "./clock.ts";
