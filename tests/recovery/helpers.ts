/**
 * Shared builders for the recovery/persistence suite. Not a `*.test.ts`, so
 * vitest imports it but never collects it as a test file.
 *
 * These tests run the loop with the **real** fs adapters (`FsJournal` /
 * `NdjsonEventLog`) against a throwaway tmpdir, and Fakes for the
 * board/runtime/git/clock/config seams — exercising persistence + recovery for
 * real while keeping the rest deterministic and I/O-free.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Card, CardJournal, CardPolicy } from "../../src/domain/types.ts";
import {
  FakeBoard,
  FakeConfig,
  FakeGit,
  FakeRuntime,
  FixedClock,
} from "../../src/adapters/fake/index.ts";
import { FsJournal } from "../../src/adapters/fs/journal.ts";
import { NdjsonEventLog } from "../../src/adapters/fs/eventlog.ts";
import type { LoopPorts } from "../../src/app/loop.ts";

export function mkPolicy(over: Partial<CardPolicy> = {}): CardPolicy {
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

export function mkCard(over: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    repo: "owner/name",
    baseBranch: "main",
    branch: "dev3/task-card1",
    worktreePath: "/wt/card-1",
    lane: "todo",
    prompt: "do the thing",
    acceptanceCriteria: [],
    policy: mkPolicy(),
    ...over,
  };
}

/** A green, never-merged journal seeded for a card (last attempt green). */
export function greenJournal(cardId: string, now = 1_000): CardJournal {
  return {
    cardId,
    attempts: [{ n: 1, outcome: "green", startedAt: now, endedAt: now }],
    consecutiveFailures: 0,
    totalTokens: 0,
    pending: {},
  };
}

/** Make a unique throwaway state dir; returns the path + a cleanup fn. */
export async function makeStateDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(`${tmpdir()}/dev3-loop-recovery-`);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** All the ports for a recovery run: real fs persistence + Fakes for everything else. */
export interface RecoveryHarness {
  ports: LoopPorts;
  board: FakeBoard;
  runtime: FakeRuntime;
  git: FakeGit;
  clock: FixedClock;
  journal: FsJournal;
  eventLog: NdjsonEventLog;
}

/**
 * Wire a harness over a given `stateDir`. Reusing the same `stateDir` across two
 * `wire()` calls simulates a process restart: the on-disk journal + event log
 * survive, the in-RAM ports do not.
 */
export function wire(stateDir: string, cards: Card[], now = 1_000): RecoveryHarness {
  const board = new FakeBoard(cards);
  const runtime = new FakeRuntime();
  const git = new FakeGit();
  const clock = new FixedClock(now);
  const journal = new FsJournal(`${stateDir}/journal`);
  const eventLog = new NdjsonEventLog(stateDir);
  const config = new FakeConfig(cards[0]?.policy ?? mkPolicy());
  const ports: LoopPorts = { board, runtime, git, journal, eventLog, clock, config };
  return { ports, board, runtime, git, clock, journal, eventLog };
}
