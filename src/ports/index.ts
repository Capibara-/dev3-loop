// Barrel for the ports & DTOs. Ports import only domain types and these DTOs — never an
// adapter. The domain core depends on these interfaces; adapters implement them.

export type { BoardPort } from "./board.ts";
export type { RuntimePort } from "./runtime.ts";
export type { GitPort } from "./git.ts";
export type { JournalPort } from "./journal.ts";
export type { EventLogPort } from "./eventlog.ts";
export type { ClockPort } from "./clock.ts";
export type { ConfigPort } from "./config.ts";

export type {
  CheckResult,
  MergeResult,
  PrResult,
  ImplementorResult,
  ReviewCriterion,
  Review,
  LoopEvent,
  LoopEventType,
  Observation,
} from "./dto.ts";
