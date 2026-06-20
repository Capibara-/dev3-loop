/**
 * Compile-only type test for the ports & DTOs (PLAN §5/§10/§11 / T5 acceptance).
 *
 * Its real job is to fail `tsc --noEmit` if a port interface or DTO shape drifts
 * from the spec: the file constructs a concrete value for every DTO and a stub
 * implementation of every port, so a renamed/removed method or field stops
 * compiling. The `vitest` assertions are a thin formality so it's also run by
 * `vitest run`. Acceptance: this imports only ports + domain types — never an
 * adapter.
 */
import { expect, test } from "vitest";
import type { Card } from "../../src/domain/types.ts";
import type {
  BoardPort,
  CheckResult,
  ClockPort,
  ConfigPort,
  EventLogPort,
  GitPort,
  GraderReview,
  JournalPort,
  LoopEvent,
  MergeResult,
  PrResult,
  ProducerResult,
  RuntimePort,
} from "../../src/ports/index.ts";

// --- A minimal Card to thread through the port method signatures. ---
const card: Card = {
  id: "abcd1234",
  repo: "owner/name",
  baseBranch: "main",
  branch: "dev3/task-abcd1234",
  worktreePath: null,
  lane: "in-progress",
  prompt: "do the thing",
  acceptanceCriteria: [],
  policy: {
    merge: "open_pr",
    maxConsecutiveFailures: 3,
    maxTotalAttempts: 6,
    stallMs: 600_000,
    producer: { agent: "claude" },
    grader: { agent: "gemini" },
    checksCmd: "tsc --noEmit",
  },
};

// --- One concrete value per DTO, exercising required + optional fields. ---
const checkResult: CheckResult = {
  passed: false,
  exitCode: 1,
  stdout: "",
  stderr: "boom",
  durationMs: 42,
  failingTests: ["a", "b"],
};
const mergeResult: MergeResult = { merged: true, alreadyMerged: false, commit: "deadbeef" };
const prResult: PrResult = { url: "https://example/pr/1", number: 1, alreadyExisted: false };
const producerResult: ProducerResult = {
  status: "done",
  summary: "did it",
  blockedQuestion: null,
  claimedTestsPass: true,
};
const graderReview: GraderReview = {
  verdict: "changes_requested",
  criteria: [{ criterion: "compiles", met: false, note: "type error" }],
  blocking: ["fix the type error"],
  ranChecks: true,
};
const event: LoopEvent = {
  ts: 0,
  cardId: card.id,
  type: "intent",
  action: "Merge",
  actionId: "action-1",
  detail: { reason: "human gate reached" },
};

// --- Stub implementations: presence of every method locks each port shape. ---
const board: BoardPort = {
  listCards: async () => [card],
  moveCard: async () => {},
  addNote: async () => {},
  setOverview: async () => {},
  watch: (onChange) => {
    onChange();
    return () => {};
  },
};
const runtime: RuntimePort = {
  launchProducer: async () => {},
  launchGrader: async () => {},
  sendFixPrompt: async () => {},
  capture: async () => null,
  isAlive: async () => true,
  readResult: async () => producerResult,
  readReview: async () => graderReview,
};
const git: GitPort = {
  diff: async () => "",
  runChecks: async () => checkResult,
  isMerged: async () => false,
  merge: async () => mergeResult,
  openPr: async () => prResult,
};
const journal: JournalPort = {
  loadAll: async () => ({}),
  persist: async () => {},
};
const eventLog: EventLogPort = { append: async () => {} };
const clock: ClockPort = { now: () => 0 };
const config: ConfigPort = { policyFor: async () => card.policy };

test("ports and DTOs compile against stub implementations", async () => {
  expect(await board.listCards()).toHaveLength(1);
  expect(await runtime.isAlive(card)).toBe(true);
  expect((await git.merge(card)).merged).toBe(true);
  expect(await journal.loadAll()).toEqual({});
  await eventLog.append(event);
  expect(clock.now()).toBe(0);
  expect((await config.policyFor(card)).merge).toBe("open_pr");
  expect(checkResult.passed).toBe(false);
  expect(prResult.alreadyExisted).toBe(false);
  expect(graderReview.verdict).toBe("changes_requested");
});
