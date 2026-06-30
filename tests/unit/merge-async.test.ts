/**
 * Async merge completion (fakes). Under `gh pr merge --auto`, Merge is *initiate*, not done:
 * the call returns before GitHub merges. This proves the loop honours that:
 *  - the initiating Merge returns not-yet-merged ⇒ `terminal` stays unset;
 *  - decide() re-initiates on later ticks while still unmerged, and a re-initiate over an
 *    already-armed auto-merge is NOT treated as an error;
 *  - the tick where isMerged flips true sets `terminal: "merged"` exactly once, with no
 *    further merge() call.
 */
import { describe, expect, test } from "vitest";
import { createLoop, type LoopPorts } from "../../src/app/loop.ts";
import {
  FakeBoard,
  FakeConfig,
  FakeEventLog,
  FakeGit,
  FakeJournal,
  FakeRuntime,
  FixedClock,
} from "../../src/adapters/fake/index.ts";
import type { Card, CardJournal, CardPolicy } from "../../src/domain/types.ts";

const MERGE_COL = "ready_to_merge";

function mkPolicy(over: Partial<CardPolicy> = {}): CardPolicy {
  return {
    merge: "merge_when_green",
    maxConsecutiveFailures: 3,
    maxTotalAttempts: 6,
    stallMs: 600_000,
    implementor: { agent: "claude" },
    reviewer: { agent: "gemini" },
    checksCmd: "tsc --noEmit",
    ...over,
  };
}

function mkCard(): Card {
  return {
    id: "card-1",
    repo: "owner/name",
    baseBranch: "main",
    branch: "dev3/task-card1",
    worktreePath: "/wt/card-1",
    lane: "review-by-user",
    customColumnId: MERGE_COL,
    prompt: "do the thing",
    acceptanceCriteria: [],
    policy: mkPolicy(),
  };
}

// A green head sitting in the merge column, awaiting merge.
function greenJournal(cardId: string): CardJournal {
  return {
    cardId,
    attempts: [{ n: 1, outcome: "green", startedAt: 1_000, endedAt: 1_000 }],
    consecutiveFailures: 0,
    totalTokens: 0,
    pending: {},
  };
}

function harness(card: Card) {
  const git = new FakeGit();
  const journal = new FakeJournal([greenJournal(card.id)]);
  const ports: LoopPorts = {
    board: new FakeBoard([card]),
    runtime: new FakeRuntime(),
    git,
    journal,
    eventLog: new FakeEventLog(),
    clock: new FixedClock(1_000),
    config: new FakeConfig(card.policy),
  };
  return { loop: createLoop(ports, { concurrencyCap: 10 }), git, journal };
}

describe("async merge completion", () => {
  test("initiate returns not-yet-merged ⇒ terminal unset; later tick flips it to merged", async () => {
    const card = mkCard();
    const { loop, git, journal } = harness(card);
    git.armAutoMerge(card.id); // gh pr merge --auto: armed, completes later

    // Tick 1: initiate. merge() returns pending (not merged) ⇒ terminal must stay unset.
    await loop.tick();
    expect(git.mergeCalls).toEqual([card.id]);
    expect((await journal.loadAll())[card.id]!.terminal).toBeUndefined();
    expect((await journal.loadAll())[card.id]!.pending).toEqual({}); // write-ahead marker cleared

    // Tick 2: still unmerged ⇒ decide re-initiates idempotently. A re-armed auto-merge is a safe
    // no-op, never an error.
    await loop.tick();
    expect(git.mergeCalls).toEqual([card.id, card.id]);
    expect((await journal.loadAll())[card.id]!.terminal).toBeUndefined();

    // GitHub's auto-merge fires.
    git.completeAutoMerge(card.id);

    // Tick 3: isMerged now true ⇒ the loop records terminal:"merged" exactly once, with NO further
    // merge() call (completion is read off isMerged, never re-merged).
    await loop.tick();
    expect((await journal.loadAll())[card.id]!.terminal).toBe("merged");
    expect(git.mergeCalls).toEqual([card.id, card.id]); // unchanged ⇒ no merge on the completion tick

    // Tick 4: terminal merged ⇒ fully settled, NoOp forever.
    await loop.tick();
    expect(git.mergeCalls).toEqual([card.id, card.id]);
    expect((await journal.loadAll())[card.id]!.terminal).toBe("merged");
  });

  test("synchronous merge (no auto-merge) marks terminal on the initiating tick", async () => {
    const card = mkCard();
    const { loop, git, journal } = harness(card); // FakeGit default: merge completes immediately

    await loop.tick();
    expect(git.mergeCalls).toEqual([card.id]);
    expect((await journal.loadAll())[card.id]!.terminal).toBe("merged");
  });
});
