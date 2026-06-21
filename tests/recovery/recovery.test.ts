/**
 * Recovery suite, run with the real fs persistence adapters
 * (`FsJournal`/`NdjsonEventLog`) over a throwaway tmpdir:
 *
 *  - Crash between a `Merge` intent and its `done` ⇒ restart ⇒ `isMerged` true ⇒
 *    **no second merge** (write-ahead + exactly-once).
 *  - `events.ndjson` is a faithful audit trace (every intent has a matching done,
 *    lane moves + guardrail trips recorded) and `replay` renders a timeline.
 *  - A lost `fs.watch` event still converges on the next periodic reconcile
 *    (level-triggered correctness).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLoop } from "../../src/app/loop.ts";
import { recover } from "../../src/app/recover.ts";
import { replay } from "../../src/app/replay.ts";
import type { GiveUpPredicate } from "../../src/domain/reconcile.ts";
import type { CardJournal } from "../../src/domain/types.ts";
import { greenJournal, makeStateDir, mkCard, wire } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await makeStateDir());
});
afterEach(() => cleanup());

const MERGE_COL = "ready_to_merge";

// --- exactly-once merge across a crash ------------------------------------

describe("exactly-once merge / write-ahead recovery", () => {
  test("a clean merge tick records intent+done, clears pending, marks terminal", async () => {
    const card = mkCard({ customColumnId: MERGE_COL, lane: "review-by-user" });
    const h = wire(dir, [card]);
    await h.journal.persist(greenJournal(card.id)); // green head awaiting merge

    const loop = createLoop(h.ports, { concurrencyCap: 10 });
    await loop.tick();

    expect(h.git.mergeCalls).toEqual([card.id]); // merged exactly once
    const loaded = await h.journal.loadAll();
    expect(loaded[card.id]!.terminal).toBe("merged");
    expect(loaded[card.id]!.pending).toEqual({}); // marker cleared on success

    const { events } = await replay(dir);
    const merge = events.filter((e) => e.action === "Merge");
    expect(merge.map((e) => e.type)).toEqual(["intent", "done"]);
  });

  test("crash between Merge intent and done ⇒ recovery sees merged ⇒ no second merge", async () => {
    const card = mkCard({ customColumnId: MERGE_COL, lane: "review-by-user" });
    const actionId = `${card.id}:Merge:1:0`;

    // Pre-crash on-disk state: a Merge intent written, the merge actually executed
    // in git, but the process died BEFORE persisting `done` / clearing the marker.
    const seed = wire(dir, [card]);
    const crashed: CardJournal = {
      ...greenJournal(card.id),
      pending: { [actionId]: { kind: "Merge", startedAt: 1 } },
    };
    await seed.journal.persist(crashed);
    await seed.eventLog.append({ ts: 1, cardId: card.id, type: "intent", action: "Merge", actionId });

    // --- restart: fresh in-RAM ports, same disk. Reality: the branch IS merged. ---
    const h = wire(dir, [card]);
    h.git.markMerged(card.id);

    const report = await recover(h.ports);
    expect(report.recovered).toEqual([
      { cardId: card.id, actionId, kind: "Merge", resolution: "merged" },
    ]);
    expect(h.git.mergeCalls).toEqual([]); // recovery only READ isMerged — never re-merged

    const afterRecover = await h.journal.loadAll();
    expect(afterRecover[card.id]!.terminal).toBe("merged");
    expect(afterRecover[card.id]!.pending).toEqual({});

    // A subsequent reconcile must not merge again.
    const loop = createLoop(h.ports, { concurrencyCap: 10 });
    await loop.tick();
    expect(h.git.mergeCalls).toEqual([]); // STILL zero ⇒ exactly-once across the crash

    // The dangling intent is now closed in the audit trace by a recovered `done`.
    const { events, unresolved } = await replay(dir);
    expect(unresolved).toEqual([]);
    const done = events.find((e) => e.type === "done" && e.actionId === actionId);
    expect(done?.detail).toMatchObject({ recovered: "merged" });
  });

  test("recover is a no-op when no markers are pending", async () => {
    const card = mkCard({ customColumnId: MERGE_COL });
    const h = wire(dir, [card]);
    await h.journal.persist(greenJournal(card.id));
    const report = await recover(h.ports);
    expect(report.recovered).toEqual([]);
    expect(h.git.mergeCalls).toEqual([]);
  });
});

// --- faithful audit trace + replay ----------------------------------------

describe("events.ndjson audit trace + replay", () => {
  // Card B's seeded red head + this predicate ⇒ a guardrail trip (GiveUp).
  const stopOnRed: GiveUpPredicate = (journal) =>
    journal.attempts.some((a) => a.outcome === "red") ? { stop: true, reason: "cap" } : { stop: false };

  test("intent/done pairs match; lane moves + guardrail trips recorded; replay reads", async () => {
    const promoting = mkCard({ id: "A", lane: "todo" });
    const failing = mkCard({ id: "B", lane: "in-progress" });
    const h = wire(dir, [promoting, failing]);
    await h.journal.persist({
      cardId: "B",
      attempts: [{ n: 1, outcome: "red", startedAt: 1, endedAt: 1, fixPromptSent: true }],
      consecutiveFailures: 1,
      totalTokens: 0,
      pending: {},
    });

    const loop = createLoop(h.ports, { concurrencyCap: 10, shouldGiveUp: stopOnRed });
    await loop.tick();

    const { events, timeline, unresolved } = await replay(dir);

    // (a) every intent has a matching done (none interrupted).
    expect(unresolved).toEqual([]);
    const intents = events.filter((e) => e.type === "intent").map((e) => e.actionId);
    const dones = new Set(events.filter((e) => e.type === "done").map((e) => e.actionId));
    for (const id of intents) expect(dones.has(id!)).toBe(true);

    // (b) a lane move (A: todo→in-progress) and a guardrail trip (B: GiveUp) are recorded.
    const move = events.find((e) => e.action === "MoveLane" && e.type === "done");
    expect(move?.detail).toMatchObject({ to: "in-progress", expect: "todo" });
    const trip = events.find((e) => e.action === "GiveUp" && e.type === "done");
    expect(trip?.detail).toMatchObject({ reason: "cap" });

    // (c) replay renders a readable, classified timeline.
    expect(timeline).toContain("lane-move");
    expect(timeline).toContain("guardrail-trip");
    expect(timeline).toContain("in-progress");
    expect(timeline).toContain("reason=cap");
  });

  test("replay surfaces an unresolved-on-crash marker (intent with no done)", async () => {
    const h = wire(dir, [mkCard()]);
    await h.eventLog.append({ ts: 1, cardId: "x", type: "intent", action: "Merge", actionId: "x:Merge:1:0" });
    const { unresolved, timeline } = await replay(dir);
    expect(unresolved).toEqual(["x:Merge:1:0"]);
    expect(timeline).toContain("unresolved-on-crash");
  });
});

// --- lost fs.watch event still converges ----------------------------------

describe("level-triggered convergence after a lost watch event", () => {
  test("a finish that no watch signalled is still picked up by the next periodic tick", async () => {
    const card = mkCard({ id: "C", lane: "in-progress" });
    const h = wire(dir, [card]);
    await h.journal.persist({
      cardId: "C",
      attempts: [],
      consecutiveFailures: 0,
      totalTokens: 0,
      pending: {},
    });

    const loop = createLoop(h.ports, { concurrencyCap: 10 });

    // Tick 1: implementor still working (no result yet) ⇒ nothing to do.
    await loop.tick();
    expect((await h.journal.loadAll())["C"]!.attempts).toEqual([]);
    expect(h.git.checkCalls).toEqual([]);

    // The implementor finishes — the change a watch WOULD have signalled. We fire
    // NO watch callback (the loop never even subscribes); correctness must come
    // purely from the next periodic full reconcile.
    h.runtime.setResult("C", { status: "done", summary: "ok", blockedQuestion: null, claimedTestsPass: true });
    h.git.setDiff("C", "diff --git a/x b/x\n+work");

    // Tick 2 (periodic): re-derives from durable state, runs checks, folds GREEN.
    await loop.tick();
    expect(h.git.checkCalls).toEqual(["C"]);
    const converged = (await h.journal.loadAll())["C"]!;
    expect(converged.attempts.map((a) => a.outcome)).toEqual(["green"]);

    // Tick 3: green head ⇒ advance to the reviewer — the loop kept converging with
    // no watch wake-up at any point.
    await loop.tick();
    const moves = h.board.moves.map((m) => m.to);
    expect(moves).toContain("review-by-ai");
  });
});
