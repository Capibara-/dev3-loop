/**
 * Barrel for the in-memory `Fake*` adapters. These are the **only**
 * way the pure core is exercised — no tmux, git, dev-3.0, or fs I/O.
 *
 * @module adapters/fake
 */

export { FakeBoard } from "./board.ts";
export type { MoveRecord, NoteRecord, OverviewRecord } from "./board.ts";
export { FakeRuntime } from "./runtime.ts";
export type { RuntimeCall } from "./runtime.ts";
export { FakeGit } from "./git.ts";
export { FakeJournal } from "./journal.ts";
export { FakeEventLog } from "./eventlog.ts";
export { FixedClock } from "./clock.ts";
export { FakeConfig } from "./config.ts";
