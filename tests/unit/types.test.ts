/**
 * Compile-only type test for the domain model.
 *
 * Its real job is to fail `tsc --noEmit` if the {@link Action} union,
 * {@link Lane}, or the core interfaces drift from the spec (the exhaustive
 * `assertNever` switches stop compiling on drift). The `vitest` assertions are
 * a thin formality so the file is also exercised by `vitest run`.
 */
import { expect, test } from "vitest";
import type {
  Action,
  AgentSpec,
  AttemptOutcome,
  AttemptRecord,
  Card,
  CardJournal,
  CardPolicy,
  CustomColumnId,
  Lane,
  MergePolicy,
} from "../../src/domain/types.ts";

/** assertNever: a value of type `never` here proves the switch is exhaustive. */
function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

/**
 * Exhaustive switch over `Action.kind`. If a variant is added to or removed
 * from {@link Action} without updating this switch, the `assertNever(action)`
 * call stops type-checking — `tsc --noEmit` fails.
 */
function describeAction(action: Action): string {
  switch (action.kind) {
    case "NoOp":
      return "noop";
    case "LaunchProducer":
      return `launch-implementor:${action.card.id}`;
    case "RunChecks":
      return `run-checks:${action.card.id}`;
    case "LaunchGrader":
      return `launch-reviewer:${action.card.id}`;
    case "SendFixPrompt":
      return `send-fix:${action.card.id}:${action.findings.length}`;
    case "MoveLane":
      return `move:${action.card.id}->${action.to}${action.expect ? `@${action.expect}` : ""}`;
    case "Merge":
      return `merge:${action.card.id}`;
    case "OpenPr":
      return `open-pr:${action.card.id}`;
    case "GiveUp":
      return `give-up:${action.card.id}:${action.reason}`;
    default:
      return assertNever(action);
  }
}

/** Exhaustive switch over every {@link Lane} member (compile-time guard). */
function isObserveOnly(lane: Lane): boolean {
  switch (lane) {
    case "todo":
    case "in-progress":
    case "user-questions":
    case "review-by-ai":
    case "review-by-user":
    case "review-by-colleague":
      return false;
    case "completed":
    case "cancelled":
      return true;
    default:
      return assertNever(lane);
  }
}

/** Exhaustive switch over {@link MergePolicy} (compile-time guard). */
function autoMerges(policy: MergePolicy): boolean {
  switch (policy) {
    case "open_pr":
      return false;
    case "merge_when_green":
    case "fix_until_green_and_merge":
      return true;
    default:
      return assertNever(policy);
  }
}

/** Exhaustive switch over {@link AttemptOutcome} (compile-time guard). */
function isFailure(outcome: AttemptOutcome): boolean {
  switch (outcome) {
    case "green":
      return false;
    case "red":
    case "stalled":
    case "error":
      return true;
    default:
      return assertNever(outcome);
  }
}

// --- A fully-populated Card, exercising every field incl. optionals. ---
const spec: AgentSpec = { agent: "claude", config: "claude-default-opus48" };
const policy: CardPolicy = {
  merge: "fix_until_green_and_merge",
  maxConsecutiveFailures: 3,
  maxTotalAttempts: 6,
  stallMs: 600_000,
  tokenBudget: 1_000_000,
  implementor: spec,
  reviewer: { agent: "gemini", config: "gemini-default" },
  checksCmd: "bun run test && tsc --noEmit",
};
const card: Card = {
  id: "abcd1234-...",
  repo: "owner/name",
  baseBranch: "main",
  branch: "dev3/task-abcd1234",
  worktreePath: "/path/to/worktree",
  lane: "in-progress",
  customColumnId: null,
  prompt: "do the thing",
  acceptanceCriteria: ["compiles", "tests pass"],
  policy,
};

const attempt: AttemptRecord = {
  n: 1,
  outcome: "red",
  failureSignature: "sig",
  diffHash: "hash",
  tokensSpent: 1234,
  startedAt: 0,
  endedAt: 10,
};
const journal: CardJournal = {
  cardId: card.id,
  attempts: [attempt],
  consecutiveFailures: 1,
  totalTokens: 1234,
  lastHeartbeatAt: 5,
  pending: { "action-1": { kind: "Merge", startedAt: 0 } },
  terminal: "merged",
};

// `to` accepts a custom-column id (string) as well as a Lane.
const customCol: CustomColumnId = "ready_to_merge";

const everyAction: Action[] = [
  { kind: "NoOp" },
  { kind: "LaunchProducer", card },
  { kind: "RunChecks", card },
  { kind: "LaunchGrader", card },
  { kind: "SendFixPrompt", card, findings: "fix this" },
  { kind: "MoveLane", card, to: "review-by-ai", expect: "in-progress", note: "promoting" },
  { kind: "MoveLane", card, to: customCol },
  { kind: "Merge", card },
  { kind: "OpenPr", card },
  { kind: "GiveUp", card, reason: "stall" },
];

test("domain types compile and switches are exhaustive", () => {
  expect(everyAction.map(describeAction)).toHaveLength(everyAction.length);
  expect(isObserveOnly("completed")).toBe(true);
  expect(isObserveOnly("todo")).toBe(false);
  expect(autoMerges("open_pr")).toBe(false);
  expect(autoMerges("merge_when_green")).toBe(true);
  expect(isFailure("green")).toBe(false);
  expect(isFailure(journal.attempts[0]!.outcome)).toBe(true);
});
