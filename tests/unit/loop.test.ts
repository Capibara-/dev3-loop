/**
 * Composition-root + tick-loop tests.
 *
 * The whole loop runs against the in-memory Fakes — **no real I/O**. Three
 * acceptance proofs from the task:
 *  1. N ticks drive one card `todo → in-progress → (RunChecks → GREEN attempt) →
 *     review-by-ai → review-by-user`, asserting the event-log / journal progression.
 *  2. the promotion-gate seam: budget = 1 with 2 todo cards ⇒ only ONE promotes.
 *  3. `dry-run` performs zero port mutations.
 *
 * Plus the fold contract (reviewer `changes_requested` → red attempt +
 * exactly-once `fixPromptSent`) and the level-triggered interval runner.
 */
import { describe, expect, test } from "vitest";
import {
  concurrencyBudget,
  createLoop,
  type LoopPorts,
  runLoop,
} from "../../src/app/loop.ts";
import {
  FakeBoard,
  FakeConfig,
  FakeEventLog,
  FakeGit,
  FakeJournal,
  FakeRuntime,
  FixedClock,
} from "../../src/adapters/fake/index.ts";
import type { AttemptRecord, Card, CardJournal, CardPolicy } from "../../src/domain/types.ts";

// --- builders -------------------------------------------------------------

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

function mkCard(over: Partial<Card> = {}): Card {
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

/** Wire a loop over fresh fakes; returns the loop + every port for assertions. */
function harness(
  cards: Card[],
  opts: { dryRun?: boolean; cap?: number; journals?: CardJournal[]; policy?: CardPolicy } = {},
) {
  const ports: LoopPorts = {
    board: new FakeBoard(cards),
    runtime: new FakeRuntime(),
    git: new FakeGit(),
    journal: new FakeJournal(opts.journals ?? []),
    eventLog: new FakeEventLog(),
    clock: new FixedClock(1_000),
    config: new FakeConfig(opts.policy ?? mkPolicy()),
  };
  const loop = createLoop(ports, { concurrencyCap: opts.cap ?? 20, dryRun: opts.dryRun ?? false });
  return { loop, ...ports };
}

// --- 1. happy path: full lane progression --------------------------------

describe("tick() happy path", () => {
  test("drives todo → in-progress → RunChecks(GREEN) → review-by-ai → review-by-user", async () => {
    const card = mkCard();
    const h = harness([card]);
    const board = h.board as FakeBoard;
    const runtime = h.runtime as FakeRuntime;
    const git = h.git as FakeGit;
    const journal = h.journal as FakeJournal;
    const events = h.eventLog as FakeEventLog;

    // Tick 1: todo → in-progress (+ implementor launched).
    await h.loop.tick();
    expect(board.cards[0]!.lane).toBe("in-progress");
    expect(board.moves).toEqual([
      { id: "card-1", to: "in-progress", expect: "todo", applied: true },
    ]);
    expect(runtime.producerLaunches.map((c) => c.cardId)).toEqual(["card-1"]);

    // The implementor announces done with a non-empty diff.
    runtime.setResult("card-1", {
      status: "done",
      summary: "implemented",
      blockedQuestion: null,
      claimedTestsPass: true,
    });
    git.setDiff("card-1", "diff --git a/x b/x\n+done");

    // Tick 2: result.json present, fresh diff ⇒ RunChecks (defaults GREEN) ⇒ green attempt.
    await h.loop.tick();
    expect(git.checkCalls).toEqual(["card-1"]);
    const j2 = (await journal.loadAll())["card-1"]!;
    expect(j2.attempts).toHaveLength(1);
    expect(j2.attempts[0]!.outcome).toBe("green");
    expect(board.cards[0]!.lane).toBe("in-progress"); // not yet handed to reviewer

    // Tick 3: last attempt green ⇒ hand to reviewer (review-by-ai), reviewer launched.
    await h.loop.tick();
    expect(board.cards[0]!.lane).toBe("review-by-ai");
    expect(runtime.graderLaunches.map((c) => c.cardId)).toEqual(["card-1"]);
    // The reviewer is launched with the adversarial read-only rubric (not a bare prompt): it
    // must re-run the checks, diff origin/<base>, and write the verdict file.
    const rubric = runtime.graderLaunches[0]!.prompt!;
    expect(rubric).toContain("READ-ONLY reviewer");
    expect(rubric).toContain(".dev3/review.json");
    expect(rubric).toContain("origin/main");
    expect(git.checkCalls).toEqual(["card-1"]); // RunChecks did NOT re-fire (sticky result)

    // The reviewer passes.
    runtime.setReview("card-1", { verdict: "pass", criteria: [], blocking: [], ranChecks: true });

    // Tick 4: verdict pass in review-by-ai ⇒ advance to the human gate.
    await h.loop.tick();
    expect(board.cards[0]!.lane).toBe("review-by-user");

    // Tick 5: human gate holds ⇒ NoOp (no further moves).
    const movesBefore = board.moves.length;
    await h.loop.tick();
    expect(board.moves.length).toBe(movesBefore);

    // Event log is a faithful intent/done audit spine.
    const intents = events.events.filter((e) => e.type === "intent");
    const dones = events.events.filter((e) => e.type === "done");
    expect(intents.length).toBe(dones.length);
    for (const i of intents) {
      expect(dones.some((d) => d.actionId === i.actionId)).toBe(true);
    }
    // The progression is visible as three MoveLane intents (in-progress →
    // review-by-ai → review-by-user), all for the one card.
    const lanes = events.events
      .filter((e) => e.type === "intent" && e.action === "MoveLane")
      .map((e) => e.cardId);
    expect(lanes).toEqual(["card-1", "card-1", "card-1"]);
  });
});

// --- 1b. out-of-band review: card never enters review-by-ai ---------------

describe("tick() out-of-band review", () => {
  const oobPolicy = mkPolicy({ reviewMode: "out-of-band" });

  async function driveToGreenReviewer() {
    const card = mkCard();
    const h = harness([card], { policy: oobPolicy });
    const runtime = h.runtime as FakeRuntime;
    const git = h.git as FakeGit;
    const journal = h.journal as FakeJournal;

    await h.loop.tick(); // todo → in-progress
    runtime.setResult("card-1", { status: "done", summary: "x", blockedQuestion: null, claimedTestsPass: true });
    git.setDiff("card-1", "diff --git a/x b/x\n+done");
    await h.loop.tick(); // RunChecks → green attempt
    await h.loop.tick(); // green + out-of-band ⇒ LaunchGrader (card STAYS in-progress)
    return { h, runtime, journal, board: h.board as FakeBoard };
  }

  test("green ⇒ reviewer launched in-place; card stays in-progress, never review-by-ai", async () => {
    const { runtime, journal, board } = await driveToGreenReviewer();
    expect(runtime.graderLaunches.map((c) => c.cardId)).toEqual(["card-1"]);
    expect(board.cards[0]!.lane).toBe("in-progress"); // NOT review-by-ai
    expect(board.moves.some((m) => m.to === "review-by-ai")).toBe(false);
    // The green attempt is marked launched ⇒ the reviewer is spawned exactly once.
    const green = (await journal.loadAll())["card-1"]!.attempts.at(-1)!;
    expect(green.outcome).toBe("green");
    expect(green.reviewerLaunched).toBe(true);
    // The recorded launch prompt is the real read-only rubric.
    expect(runtime.graderLaunches[0]!.prompt!).toContain("READ-ONLY reviewer");
  });

  test("reviewer launched but no verdict yet ⇒ NoOp (no re-launch)", async () => {
    const { h, runtime, board } = await driveToGreenReviewer();
    await h.loop.tick(); // still no review.json
    expect(runtime.graderLaunches).toHaveLength(1); // not re-spawned
    expect(board.cards[0]!.lane).toBe("in-progress");
  });

  test("verdict pass ⇒ in-progress → review-by-user (human gate), still never review-by-ai", async () => {
    const { h, runtime, board } = await driveToGreenReviewer();
    runtime.setReview("card-1", { verdict: "pass", criteria: [], blocking: [], ranChecks: true });
    await h.loop.tick();
    expect(board.cards[0]!.lane).toBe("review-by-user");
    expect(board.moves.some((m) => m.to === "review-by-ai")).toBe(false);
  });

  test("verdict changes_requested ⇒ SendFixPrompt, folded as a red attempt, stays in-progress", async () => {
    const { h, runtime, journal, board } = await driveToGreenReviewer();
    runtime.setReview("card-1", {
      verdict: "changes_requested", criteria: [], blocking: ["Handle empty input"], ranChecks: true,
    });
    await h.loop.tick();
    expect(runtime.fixPrompts.map((c) => c.cardId)).toEqual(["card-1"]);
    expect(runtime.fixPrompts[0]!.prompt!).toContain("Handle empty input");
    expect(board.cards[0]!.lane).toBe("in-progress"); // no move
    const j = (await journal.loadAll())["card-1"]!;
    const last = j.attempts.at(-1)!;
    expect(last.outcome).toBe("red"); // reviewer rejection folded as a failure
    expect(last.fixPromptSent).toBe(true);
    expect(j.consecutiveFailures).toBe(1); // feeds the caps + breaker
  });

  test("fix loop: a new green diff re-launches the reviewer; a stale verdict never leaks", async () => {
    const card = mkCard();
    const h = harness([card], { policy: oobPolicy });
    const runtime = h.runtime as FakeRuntime;
    const git = h.git as FakeGit;
    const board = h.board as FakeBoard;
    const journal = h.journal as FakeJournal;

    await h.loop.tick(); // todo → in-progress
    runtime.setResult("card-1", { status: "done", summary: "x", blockedQuestion: null, claimedTestsPass: true });
    git.setDiff("card-1", "diff v1");
    await h.loop.tick(); // RunChecks → green (d1)
    await h.loop.tick(); // LaunchGrader (d1)
    expect(runtime.graderLaunches).toHaveLength(1);

    // Reviewer rejects d1 ⇒ fix bounces back, folded red, card stays in-progress.
    runtime.setReview("card-1", { verdict: "changes_requested", criteria: [], blocking: ["nope"], ranChecks: true });
    await h.loop.tick();
    expect(runtime.fixPrompts).toHaveLength(1);
    expect((await journal.loadAll())["card-1"]!.attempts.at(-1)!.outcome).toBe("red");

    // Implementor produces a NEW diff and re-reports done.
    git.setDiff("card-1", "diff v2 — fixed");
    await h.loop.tick(); // fresh diff ⇒ RunChecks → green (d2)
    expect((await journal.loadAll())["card-1"]!.attempts.at(-1)!.outcome).toBe("green");

    // Green d2 ⇒ the reviewer is RE-launched for the new head (not routed off d1's stale verdict).
    await h.loop.tick();
    expect(runtime.graderLaunches).toHaveLength(2);
    expect(board.cards[0]!.lane).toBe("in-progress"); // still no review-by-ai, no premature gate
    await h.loop.tick(); // no fresh verdict yet ⇒ NoOp
    expect(board.cards[0]!.lane).toBe("in-progress");

    // The d2 reviewer passes ⇒ human gate.
    runtime.setReview("card-1", { verdict: "pass", criteria: [], blocking: [], ranChecks: true });
    await h.loop.tick();
    expect(board.cards[0]!.lane).toBe("review-by-user");
    expect(board.moves.some((m) => m.to === "review-by-ai")).toBe(false);
  });
});

// --- 2. promotion-gate seam -----------------------------------------------

describe("fleet promotion gate (seam)", () => {
  test("budget = 1 with 2 todo cards ⇒ only ONE promotes in a tick", async () => {
    const a = mkCard({ id: "card-a", branch: "dev3/task-a" });
    const b = mkCard({ id: "card-b", branch: "dev3/task-b" });
    const h = harness([a, b], { cap: 1 });
    const board = h.board as FakeBoard;
    const runtime = h.runtime as FakeRuntime;

    await h.loop.tick();

    const promoted = board.cards.filter((c) => c.lane === "in-progress");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.id).toBe("card-a"); // first card consumes the only slot
    expect(board.cards.find((c) => c.id === "card-b")!.lane).toBe("todo");
    // The gated card's promotion was never issued nor its implementor launched.
    expect(board.moves.map((m) => m.id)).toEqual(["card-a"]);
    expect(runtime.producerLaunches.map((c) => c.cardId)).toEqual(["card-a"]);
  });

  test("concurrencyBudget = cap − live count", () => {
    const budget = concurrencyBudget(2);
    const todo1 = mkCard({ id: "t1", lane: "todo" });
    const todo2 = mkCard({ id: "t2", lane: "todo" });
    const live1 = mkCard({ id: "l1", lane: "in-progress" });
    const live2 = mkCard({ id: "l2", lane: "in-progress" });
    expect(budget([todo1, todo2], {})).toBe(2);
    expect(budget([todo1, live1], {})).toBe(1);
    // A journaled-terminal card frees its slot (live1 terminal ⇒ only live2 counts).
    expect(budget([live1, live2], { l1: { terminal: "merged" } as CardJournal })).toBe(1);
  });
});

// --- 3. dry-run: zero mutations -------------------------------------------

describe("dry-run", () => {
  test("computes a plan but mutates no port", async () => {
    const card = mkCard();
    const h = harness([card], { dryRun: true });
    const board = h.board as FakeBoard;
    const runtime = h.runtime as FakeRuntime;
    const git = h.git as FakeGit;
    const journal = h.journal as FakeJournal;
    const events = h.eventLog as FakeEventLog;

    const planned = await h.loop.tick();

    // The intended actions are surfaced...
    expect(planned.map((p) => p.action.kind)).toEqual(["MoveLane", "LaunchProducer"]);
    // ...but NOTHING was mutated.
    expect(board.moves).toEqual([]);
    expect(board.notes).toEqual([]);
    expect(board.cards[0]!.lane).toBe("todo");
    expect(runtime.producerLaunches).toEqual([]);
    expect(git.checkCalls).toEqual([]);
    expect(git.mergeCalls).toEqual([]);
    expect(events.events).toEqual([]);
    expect(await journal.loadAll()).toEqual({});
  });
});

// --- fold contract: reviewer rejection -----------------------------------

describe("shell fold contract", () => {
  test("reviewer changes_requested folds a red attempt with fixPromptSent (exactly-once)", async () => {
    // Card sitting in review-by-ai with one green attempt for the current head.
    const card = mkCard({ lane: "review-by-ai" });
    const greenAttempt = { n: 1, outcome: "green" as const, startedAt: 0, diffHash: "deadbeef" };
    const seed: CardJournal = {
      cardId: "card-1",
      attempts: [greenAttempt],
      consecutiveFailures: 0,
      totalTokens: 0,
      pending: {},
    };
    const h = harness([card], { journals: [seed] });
    const runtime = h.runtime as FakeRuntime;
    const git = h.git as FakeGit;
    const board = h.board as FakeBoard;
    const journal = h.journal as FakeJournal;

    // Same head (diff hashes to "deadbeef" is not required; we just need a fresh
    // rejection). Reviewer requests changes.
    git.setDiff("card-1", "diff --git a/x b/x\n+attempt");
    runtime.setReview("card-1", {
      verdict: "changes_requested",
      criteria: [],
      blocking: ["missing test for edge case"],
      ranChecks: true,
    });

    // Tick: bounce back to in-progress + fix prompt; fold a RED attempt.
    await h.loop.tick();
    expect(board.cards[0]!.lane).toBe("in-progress");
    expect(runtime.fixPrompts.map((c) => c.cardId)).toEqual(["card-1"]);

    const j = (await journal.loadAll())["card-1"]!;
    expect(j.attempts).toHaveLength(2);
    const red = j.attempts[1]!;
    expect(red.outcome).toBe("red");
    expect(red.fixPromptSent).toBe(true);
    expect(j.consecutiveFailures).toBe(1); // reviewer rejection feeds the caps

    // Next tick: in-progress, last attempt red & fixPromptSent ⇒ NoOp (no re-send).
    const before = runtime.fixPrompts.length;
    await h.loop.tick();
    expect(runtime.fixPrompts.length).toBe(before);
  });

  test("RunChecks RED increments consecutiveFailures and records a red attempt", async () => {
    const card = mkCard({ lane: "in-progress" });
    const h = harness([card]);
    const runtime = h.runtime as FakeRuntime;
    const git = h.git as FakeGit;
    const journal = h.journal as FakeJournal;

    runtime.setResult("card-1", {
      status: "done",
      summary: "claims done",
      blockedQuestion: null,
      claimedTestsPass: true, // never trusted
    });
    git.setDiff("card-1", "diff\n+x");
    git.setCheckResult("card-1", {
      passed: false,
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      durationMs: 5,
      failingTests: ["suite/a", "suite/b"],
    });

    await h.loop.tick();
    const j = (await journal.loadAll())["card-1"]!;
    expect(j.attempts).toHaveLength(1);
    expect(j.attempts[0]!.outcome).toBe("red");
    expect(j.attempts[0]!.failureSignature).toBeDefined();
    expect(j.consecutiveFailures).toBe(1);
  });
});

// --- real guardrails wired into the loop ----------------------------------

describe("guardrails end-to-end (real predicate is the loop default)", () => {
  test("a card at the consecutive-failure cap gives up → user-questions + note", async () => {
    const card = mkCard({ lane: "in-progress" });
    const red = (n: number): AttemptRecord => ({
      n,
      outcome: "red",
      startedAt: 0,
      diffHash: `d${n}`, // distinct ⇒ no oscillation; cap is the reason
    });
    const seed: CardJournal = {
      cardId: "card-1",
      attempts: [red(1), red(2), red(3)],
      consecutiveFailures: 3, // == maxConsecutiveFailures (default 3)
      totalTokens: 0,
      pending: {},
    };
    const h = harness([card], { journals: [seed] });
    const board = h.board as FakeBoard;
    const journal = h.journal as FakeJournal;
    const events = h.eventLog as FakeEventLog;

    await h.loop.tick();

    expect(board.cards[0]!.lane).toBe("user-questions");
    expect(board.notes.map((n) => n.id)).toEqual(["card-1"]);
    expect(board.notes[0]!.note).toContain("consecutive-failures");
    const j = (await journal.loadAll())["card-1"]!;
    expect(j.terminal).toBe("given_up");
    // The GiveUp is in the audit trace.
    expect(events.events.some((e) => e.action === "GiveUp")).toBe(true);
  });
});

// --- circuit breaker gates promotions -------------------------------------

describe("circuit breaker end-to-end", () => {
  test("an open breaker blocks promotion and emits breaker_open once (rising edge)", async () => {
    // Two todo cards; a history journal (not on the board) carries 3-of-4
    // non-green attempts ⇒ breaker open (≥ floor of 4, > 50%).
    const a = mkCard({ id: "card-a", branch: "dev3/task-a" });
    const b = mkCard({ id: "card-b", branch: "dev3/task-b" });
    const hist: CardJournal = {
      cardId: "hist",
      attempts: [
        { n: 1, outcome: "red", startedAt: 1 },
        { n: 2, outcome: "red", startedAt: 2 },
        { n: 3, outcome: "red", startedAt: 3 },
        { n: 4, outcome: "green", startedAt: 4 },
      ],
      consecutiveFailures: 0,
      totalTokens: 0,
      pending: {},
    };
    const h = harness([a, b], { journals: [hist] });
    const board = h.board as FakeBoard;
    const runtime = h.runtime as FakeRuntime;
    const events = h.eventLog as FakeEventLog;

    await h.loop.tick();

    // No promotions while the breaker is open.
    expect(board.cards.every((c) => c.lane === "todo")).toBe(true);
    expect(board.moves).toEqual([]);
    expect(runtime.producerLaunches).toEqual([]);
    const breakerEvents = events.events.filter((e) => e.type === "breaker_open");
    expect(breakerEvents).toHaveLength(1);
    expect(breakerEvents[0]!.detail).toMatchObject({ failRate: 0.75, windowSize: 4 });

    // Second tick: breaker still open, but no DUPLICATE event (rising-edge only).
    await h.loop.tick();
    expect(events.events.filter((e) => e.type === "breaker_open")).toHaveLength(1);
  });
});

// --- interval runner ------------------------------------------------------

describe("runLoop", () => {
  test("runs exactly maxTicks ticks with an injected sleep", async () => {
    const h = harness([mkCard()]);
    let sleeps = 0;
    const ticks = await runLoop(h.loop, {
      intervalMs: 5_000,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
      maxTicks: 3,
    });
    expect(ticks).toBe(3);
    expect(sleeps).toBe(2); // no trailing sleep after the final tick
  });

  test("shouldStop halts the loop", async () => {
    const h = harness([mkCard()]);
    let n = 0;
    const ticks = await runLoop(h.loop, {
      intervalMs: 1,
      sleep: () => Promise.resolve(),
      shouldStop: () => n++ >= 2,
    });
    expect(ticks).toBeLessThanOrEqual(2);
  });
});
