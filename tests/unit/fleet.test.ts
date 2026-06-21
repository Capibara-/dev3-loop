/**
 * Fleet-policy tests.
 *
 * {@link evaluateFleet} is PURE: a once-per-tick verdict over the full card list +
 * journals. Three proofs from the task:
 *  - the **concurrency cap** blocks promotion (`budget = max(0, cap − live)`);
 *  - the **daily-spend ceiling** drains (forces `budget = 0`, leaving in-flight
 *    cards to run);
 *  - the **circuit breaker** opens once the non-green rate over the last N
 *    completed attempts exceeds 50% — but only past the cold-start floor.
 */
import { describe, expect, test } from "vitest";
import { evaluateFleet, liveCount, type FleetOptions } from "../../src/domain/fleet.ts";
import type { AttemptRecord, Card, CardJournal, Lane } from "../../src/domain/types.ts";

// --- builders -------------------------------------------------------------

const NOW = 10_000_000;

const OPTS: FleetOptions = {
  cap: 20,
  dailySpendCeiling: Number.POSITIVE_INFINITY,
  breakerWindow: 10,
  breakerThreshold: 0.5,
  breakerMinSamples: 4,
  spendWindowMs: 86_400_000,
};
function opts(over: Partial<FleetOptions> = {}): FleetOptions {
  return { ...OPTS, ...over };
}

function mkCard(id: string, lane: Lane, customColumnId?: string): Card {
  const card: Card = {
    id,
    repo: "owner/name",
    baseBranch: "main",
    branch: `dev3/task-${id}`,
    worktreePath: `/wt/${id}`,
    lane,
    prompt: "p",
    acceptanceCriteria: [],
    policy: {
      merge: "merge_when_green",
      maxConsecutiveFailures: 3,
      maxTotalAttempts: 6,
      stallMs: 600_000,
      implementor: { agent: "claude" },
      reviewer: { agent: "gemini" },
      checksCmd: "tsc",
    },
  };
  if (customColumnId !== undefined) card.customColumnId = customColumnId;
  return card;
}

function mkJournal(id: string, attempts: AttemptRecord[], over: Partial<CardJournal> = {}): CardJournal {
  return { cardId: id, attempts, consecutiveFailures: 0, totalTokens: 0, pending: {}, ...over };
}

let nextN = 1;
function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { n: nextN++, outcome: "green", startedAt: NOW, ...over };
}

function journalMap(...js: CardJournal[]): Record<string, CardJournal> {
  return Object.fromEntries(js.map((j) => [j.cardId, j]));
}

// --- concurrency cap -------------------------------------------------------

describe("evaluateFleet — concurrency cap", () => {
  test("budget = cap − live; live = non-todo, non-terminal cards", () => {
    const cards = [
      mkCard("t1", "todo"),
      mkCard("t2", "todo"),
      mkCard("l1", "in-progress"),
      mkCard("l2", "review-by-ai"),
    ];
    expect(evaluateFleet(cards, {}, opts({ cap: 5 }), NOW).budget).toBe(3); // 5 − 2 live
    expect(evaluateFleet(cards, {}, opts({ cap: 2 }), NOW).budget).toBe(0); // saturated
  });

  test("journaled-terminal and observe-only terminal cards free their slot", () => {
    const cards = [
      mkCard("l1", "in-progress"),
      mkCard("l2", "in-progress"),
      mkCard("done", "completed"),
    ];
    const journals = journalMap(mkJournal("l1", [], { terminal: "merged" }));
    // l1 terminal (freed) + 'done' observe-only (freed) ⇒ only l2 is live.
    expect(evaluateFleet(cards, journals, opts({ cap: 3 }), NOW).budget).toBe(2);
    expect(liveCount(cards, journals)).toBe(1);
  });

  test("a custom-column card counts as live (routes off the column, not the stale lane)", () => {
    const cards = [mkCard("c1", "todo", "ready_to_merge")];
    expect(liveCount(cards, {})).toBe(1);
  });
});

// --- daily-spend ceiling ---------------------------------------------------

describe("evaluateFleet — daily-spend ceiling", () => {
  test("drains promotions (budget → 0) when in-window spend exceeds the ceiling", () => {
    const cards = [mkCard("t1", "todo"), mkCard("l1", "in-progress")];
    const journals = journalMap(
      mkJournal("l1", [attempt({ tokensSpent: 80 }), attempt({ tokensSpent: 30 })]),
    );
    // 110 > 100 ⇒ forced 0 even though concurrency had room.
    const d = evaluateFleet(cards, journals, opts({ cap: 5, dailySpendCeiling: 100 }), NOW);
    expect(d.budget).toBe(0);
    expect(d.cause).toBe("spend-ceiling");
    expect(d.breakerOpen).toBe(false);
  });

  test("spend outside the rolling window is not counted", () => {
    const cards = [mkCard("t1", "todo")];
    const old = attempt({ tokensSpent: 1_000, startedAt: NOW - 86_400_001 }); // just outside 24h
    const journals = journalMap(mkJournal("l1", [old]));
    const d = evaluateFleet(cards, journals, opts({ cap: 5, dailySpendCeiling: 100 }), NOW);
    expect(d.budget).toBe(5); // no live cards, ceiling not triggered by out-of-window spend
    expect(d.cause).toBeUndefined();
  });
});

// --- circuit breaker -------------------------------------------------------

describe("evaluateFleet — circuit breaker", () => {
  test("opens when non-green rate over the window exceeds 50%", () => {
    const cards = [mkCard("t1", "todo")];
    // 3 red + 1 green = 75% non-green over 4 attempts (≥ floor).
    const journals = journalMap(
      mkJournal("a", [attempt({ outcome: "red" }), attempt({ outcome: "red" })]),
      mkJournal("b", [attempt({ outcome: "red" }), attempt({ outcome: "green" })]),
    );
    const d = evaluateFleet(cards, journals, opts({ cap: 5 }), NOW);
    expect(d.breakerOpen).toBe(true);
    expect(d.budget).toBe(0);
    expect(d.cause).toBe("breaker");
    expect(d.failRate).toBeCloseTo(0.75);
    expect(d.windowSize).toBe(4);
  });

  test("non-green includes stalled / error, not just red", () => {
    const cards = [mkCard("t1", "todo")];
    const journals = journalMap(
      mkJournal("a", [
        attempt({ outcome: "stalled" }),
        attempt({ outcome: "error" }),
        attempt({ outcome: "red" }),
        attempt({ outcome: "green" }),
      ]),
    );
    const d = evaluateFleet(cards, journals, opts({ cap: 5 }), NOW);
    expect(d.breakerOpen).toBe(true);
    expect(d.failRate).toBeCloseTo(0.75);
  });

  test("stays closed at exactly 50% (strict threshold)", () => {
    const cards = [mkCard("t1", "todo")];
    const journals = journalMap(
      mkJournal("a", [
        attempt({ outcome: "red" }),
        attempt({ outcome: "red" }),
        attempt({ outcome: "green" }),
        attempt({ outcome: "green" }),
      ]),
    );
    const d = evaluateFleet(cards, journals, opts({ cap: 5 }), NOW);
    expect(d.breakerOpen).toBe(false);
    expect(d.budget).toBe(5);
  });

  test("cold-start floor: a single early red (below floor) does NOT open the breaker", () => {
    const cards = [mkCard("t1", "todo")];
    // 3 reds < floor of 4 ⇒ closed, despite 100% failure.
    const journals = journalMap(
      mkJournal("a", [
        attempt({ outcome: "red" }),
        attempt({ outcome: "red" }),
        attempt({ outcome: "red" }),
      ]),
    );
    const d = evaluateFleet(cards, journals, opts({ cap: 5, breakerMinSamples: 4 }), NOW);
    expect(d.breakerOpen).toBe(false);
    expect(d.budget).toBe(5);
  });

  test("window is the last N attempts by startedAt — an old bad streak doesn't linger", () => {
    const cards = [mkCard("t1", "todo")];
    // 4 old reds (low startedAt) + 4 recent greens (high startedAt); window N=4
    // sees only the recent greens ⇒ healthy.
    const oldRed = (i: number) => attempt({ outcome: "red", startedAt: NOW - 1_000 + i });
    const newGreen = (i: number) => attempt({ outcome: "green", startedAt: NOW + i });
    const journals = journalMap(
      mkJournal("a", [oldRed(0), oldRed(1), oldRed(2), oldRed(3), newGreen(0), newGreen(1), newGreen(2), newGreen(3)]),
    );
    const d = evaluateFleet(cards, journals, opts({ cap: 5, breakerWindow: 4 }), NOW);
    expect(d.breakerOpen).toBe(false);
    expect(d.windowSize).toBeUndefined(); // only set when the breaker opens
    expect(d.budget).toBe(5);
  });
});
