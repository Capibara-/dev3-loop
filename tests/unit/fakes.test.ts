/**
 * Smoke tests for the in-memory `Fake*` adapters (T6 acceptance): instantiate
 * every fake and exercise one method, plus the few behaviours other tests will
 * lean on — the `moveCard` `expect` guard, exactly-once `merge`, and journal
 * clone-on-persist. No real I/O.
 */
import { expect, test } from "vitest";
import type { Card, CardJournal, CardPolicy } from "../../src/domain/types.ts";
import {
  FakeBoard,
  FakeConfig,
  FakeEventLog,
  FakeGit,
  FakeJournal,
  FakeRuntime,
  FixedClock,
} from "../../src/adapters/fake/index.ts";

const policy: CardPolicy = {
  merge: "merge_when_green",
  maxConsecutiveFailures: 3,
  maxTotalAttempts: 6,
  stallMs: 600_000,
  producer: { agent: "claude" },
  grader: { agent: "gemini" },
  checksCmd: "tsc --noEmit",
};

const card: Card = {
  id: "card-1",
  repo: "owner/name",
  baseBranch: "main",
  branch: "dev3/task-card1",
  worktreePath: null,
  lane: "in-progress",
  prompt: "do the thing",
  acceptanceCriteria: [],
  policy,
};

test("FakeBoard records moves and honours the expect guard", async () => {
  const board = new FakeBoard([{ ...card }]);

  // Guard matches current lane → applied.
  await board.moveCard(card.id, "review-by-ai", "in-progress");
  // Guard no longer matches (card is now review-by-ai) → skipped, not an error.
  await board.moveCard(card.id, "review-by-user", "in-progress");
  await board.addNote(card.id, "hello");
  await board.setOverview(card.id, "status");

  expect(board.moves.map((m) => m.applied)).toEqual([true, false]);
  expect((await board.listCards())[0]!.lane).toBe("review-by-ai");
  expect(board.notes).toEqual([{ id: card.id, note: "hello" }]);
  expect(board.overviews[0]!.text).toBe("status");
});

test("FakeRuntime scripts result/review and records launches", async () => {
  const runtime = new FakeRuntime();
  expect(await runtime.readResult(card)).toBeNull();
  expect(await runtime.isAlive(card)).toBe(false);

  await runtime.launchProducer(card, policy.producer, "go");
  runtime.setResult(card.id, {
    status: "done",
    summary: "did it",
    blockedQuestion: null,
    claimedTestsPass: true,
  });

  expect(runtime.producerLaunches[0]!.cardId).toBe(card.id);
  expect(await runtime.isAlive(card)).toBe(true); // launch marks it alive
  expect((await runtime.readResult(card))!.status).toBe("done");
});

test("FakeGit merge is exactly-once", async () => {
  const git = new FakeGit();
  expect(await git.isMerged(card)).toBe(false);

  const first = await git.merge(card);
  const second = await git.merge(card);

  expect(first.alreadyMerged).toBe(false);
  expect(second.alreadyMerged).toBe(true);
  expect(await git.isMerged(card)).toBe(true);
  expect(git.mergeCalls).toHaveLength(2);
});

test("FakeJournal persists and clones", async () => {
  const journal = new FakeJournal();
  const j: CardJournal = {
    cardId: card.id,
    attempts: [],
    consecutiveFailures: 0,
    totalTokens: 0,
    pending: {},
  };
  await journal.persist(j);
  j.consecutiveFailures = 99; // mutate after persist — must not leak into the store

  const loaded = await journal.loadAll();
  expect(loaded[card.id]!.consecutiveFailures).toBe(0);
});

test("FakeEventLog appends in order", async () => {
  const log = new FakeEventLog();
  await log.append({ ts: 1, cardId: card.id, type: "intent", action: "Merge" });
  await log.append({ ts: 2, cardId: card.id, type: "done", action: "Merge" });
  expect(log.events.map((e) => e.type)).toEqual(["intent", "done"]);
});

test("FixedClock is settable and advances", () => {
  const clock = new FixedClock(100);
  expect(clock.now()).toBe(100);
  expect(clock.advance(50)).toBe(150);
  clock.set(0);
  expect(clock.now()).toBe(0);
});

test("FakeConfig returns default and per-card overrides", async () => {
  const config = new FakeConfig(policy);
  expect((await config.policyFor(card)).merge).toBe("merge_when_green");
  config.setPolicy(card.id, { ...policy, merge: "open_pr" });
  expect((await config.policyFor(card)).merge).toBe("open_pr");
});
