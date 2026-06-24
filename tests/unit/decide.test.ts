/**
 * Transition-table tests for the pure `decide()` state machine.
 *
 * `decide()` is PURE: it returns an **ordered** `Action[]` (`[]` = NoOp) and does
 * zero I/O, so these tests construct plain `Card`/`CardJournal`/`Observation`
 * inputs and assert on the returned list — **including order** for compound rows.
 *
 * Two invariants the rows below lean on:
 *  - The green/red **check outcome is read from `journal.attempts`, never from
 *    `obs`** (a `RunChecks` is an Action whose `CheckResult` the shell folds into an
 *    `AttemptRecord`). So red/green is seeded via `journal.attempts`.
 *  - The default in-band adapter makes `LaunchProducer`/`LaunchGrader` no-ops, but
 *    `decide()` still EMITS them next to the `MoveLane` — so the full ordered list
 *    is asserted.
 *
 * The guardrail-cap predicate is INJECTED (`shouldGiveUp`); these tests use the
 * defaulted allow-all and a stop-stub only to prove the
 * GiveUp wiring is reached.
 */
import { describe, expect, test } from "vitest";
import {
  applyHumanResume,
  decide,
  mergeGateAction,
  READY_TO_MERGE,
  type GiveUpPredicate,
} from "../../src/domain/reconcile.ts";
import type {
  Action,
  AttemptRecord,
  Card,
  CardJournal,
  CardPolicy,
  Lane,
} from "../../src/domain/types.ts";
import type { Observation } from "../../src/ports/dto.ts";
import { FixedClock } from "../../src/adapters/fake/index.ts";

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
    policy: mkPolicy(over.policy),
    ...over,
  };
}

function mkJournal(over: Partial<CardJournal> = {}): CardJournal {
  return {
    cardId: "card-1",
    attempts: [],
    consecutiveFailures: 0,
    totalTokens: 0,
    pending: {},
    ...over,
  };
}

function mkObs(over: Partial<Observation> = {}): Observation {
  return { result: null, review: null, alive: true, merged: false, ...over };
}

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { n: 1, outcome: "red", startedAt: 0, ...over };
}

const clock = new FixedClock(1_000);
const NOW = clock.now();

/** A guardrail stub that always trips — used only to prove GiveUp wiring. */
const stopWith = (reason: string): GiveUpPredicate => () => ({ stop: true, reason });

// --- table: rows with an exact, simple expected Action[] ------------------

interface Row {
  name: string;
  card: Card;
  journal: CardJournal;
  obs: Observation;
  predicate?: GiveUpPredicate;
  expected: Action[];
}

const card = mkCard();

const rows: Row[] = [
  // todo — decide() always PROPOSES promotion (fleet gate is shell-side).
  {
    name: "todo ⇒ [MoveLane→in-progress, LaunchProducer]",
    card: mkCard({ lane: "todo" }),
    journal: mkJournal(),
    obs: mkObs(),
    expected: [
      { kind: "MoveLane", card: mkCard({ lane: "todo" }), to: "in-progress", expect: "todo" },
      { kind: "LaunchProducer", card: mkCard({ lane: "todo" }) },
    ],
  },

  // in-progress, result done, diff not yet attempted, non-empty ⇒ RunChecks
  // (implementor self-report — incl. claimedTestsPass — is never trusted: we re-run).
  {
    name: "in-progress, result done, fresh non-empty diff ⇒ RunChecks (self-report ignored)",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal(),
    obs: mkObs({
      result: { status: "done", summary: "did it", blockedQuestion: null, claimedTestsPass: true },
      diffHash: "d1",
    }),
    expected: [{ kind: "RunChecks", card: mkCard({ lane: "in-progress" }) }],
  },

  // in-progress, result done over EMPTY diff (no diffHash) ⇒ GiveUp("empty-diff").
  {
    name: "in-progress, result done, empty diff ⇒ GiveUp(empty-diff)",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal(),
    obs: mkObs({
      result: { status: "done", summary: "nothing", blockedQuestion: null, claimedTestsPass: true },
    }),
    expected: [{ kind: "GiveUp", card: mkCard({ lane: "in-progress" }), reason: "empty-diff" }],
  },

  // in-progress, result blocked, diff not yet acted ⇒ MoveLane→user-questions
  // (HUMAN HANDOFF — single guarded move carrying the blocked question as a note;
  // NOT a failure, NOT a RunChecks, NOT a GiveUp).
  {
    name: "in-progress, result blocked, fresh ⇒ [MoveLane→user-questions(note)]",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal(),
    obs: mkObs({
      result: { status: "blocked", summary: "stuck", blockedQuestion: "Which DB?", claimedTestsPass: false },
      diffHash: "d1",
    }),
    expected: [
      {
        kind: "MoveLane",
        card: mkCard({ lane: "in-progress" }),
        to: "user-questions",
        expect: "in-progress",
        note: "Which DB?",
      },
    ],
  },

  // blocked result whose diff was ALREADY acted on (sticky) ⇒ NoOp.
  {
    name: "in-progress, result blocked, diff already acted ⇒ NoOp (sticky)",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal({ attempts: [attempt({ outcome: "error", diffHash: "d1" })] }),
    obs: mkObs({
      result: { status: "blocked", summary: "stuck", blockedQuestion: "Which DB?", claimedTestsPass: false },
      diffHash: "d1",
    }),
    expected: [],
  },

  // done result whose diff was ALREADY acted on, last attempt red & fix
  // already dispatched ⇒ NoOp — the never-deleted result.json must not re-fire
  // (sticky-result NoOp realized via AttemptRecord.fixPromptSent).
  {
    name: "in-progress, result done sticky (red+fixPromptSent) ⇒ NoOp",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal({
      attempts: [attempt({ outcome: "red", diffHash: "d1", fixPromptSent: true })],
      consecutiveFailures: 1,
    }),
    obs: mkObs({
      result: { status: "done", summary: "did it", blockedQuestion: null, claimedTestsPass: true },
      diffHash: "d1",
    }),
    expected: [],
  },

  // in-progress, no result, within stall, alive ⇒ NoOp (still working).
  {
    name: "in-progress, no result, alive ⇒ NoOp (still working)",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal(),
    obs: mkObs({ heartbeatAt: NOW }),
    expected: [],
  },

  // in-progress, last attempt green ⇒ [MoveLane→review-by-ai, LaunchGrader]
  // (reviewer runs only after green; red/non-compiling never reaches review-by-ai).
  {
    name: "in-progress, last attempt green ⇒ [MoveLane→review-by-ai, LaunchGrader]",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] }),
    obs: mkObs({ diffHash: "d1" }),
    expected: [
      { kind: "MoveLane", card: mkCard({ lane: "in-progress" }), to: "review-by-ai", expect: "in-progress" },
      { kind: "LaunchGrader", card: mkCard({ lane: "in-progress" }) },
    ],
  },

  // in-progress, last attempt red, fix already sent ⇒ NoOp (exactly-once fix).
  {
    name: "in-progress, last red, fixPromptSent ⇒ NoOp",
    card: mkCard({ lane: "in-progress" }),
    journal: mkJournal({
      attempts: [attempt({ outcome: "red", diffHash: "d1", fixPromptSent: true })],
      consecutiveFailures: 1,
    }),
    obs: mkObs({ diffHash: "d1" }),
    expected: [],
  },

  // review-by-ai, no review.json yet ⇒ NoOp (reviewer still running).
  {
    name: "review-by-ai, no verdict ⇒ NoOp",
    card: mkCard({ lane: "review-by-ai" }),
    journal: mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] }),
    obs: mkObs({ diffHash: "d1" }),
    expected: [],
  },

  // review verdict=pass in review-by-ai ⇒ MoveLane→review-by-user (human gate).
  {
    name: "review-by-ai, verdict pass ⇒ [MoveLane→review-by-user]",
    card: mkCard({ lane: "review-by-ai" }),
    journal: mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] }),
    obs: mkObs({
      diffHash: "d1",
      review: { verdict: "pass", criteria: [], blocking: [], ranChecks: true },
    }),
    expected: [
      { kind: "MoveLane", card: mkCard({ lane: "review-by-ai" }), to: "review-by-user", expect: "review-by-ai" },
    ],
  },

  // review verdict=pass in review-by-user ⇒ NoOp (human gate holds).
  {
    name: "review-by-user, verdict pass ⇒ NoOp (human gate)",
    card: mkCard({ lane: "review-by-user" }),
    journal: mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] }),
    obs: mkObs({
      diffHash: "d1",
      review: { verdict: "pass", criteria: [], blocking: [], ranChecks: true },
    }),
    expected: [],
  },

  // review changes_requested whose diff was ALREADY folded as a red attempt
  // (rejected) ⇒ NoOp — a sticky review.json must not re-send.
  {
    name: "review changes_requested, diff already rejected ⇒ NoOp (sticky)",
    card: mkCard({ lane: "review-by-ai" }),
    journal: mkJournal({ attempts: [attempt({ outcome: "red", diffHash: "d1", fixPromptSent: true })] }),
    obs: mkObs({
      diffHash: "d1",
      review: { verdict: "changes_requested", criteria: [], blocking: ["x"], ranChecks: true },
    }),
    expected: [],
  },

  // review-by-colleague ⇒ ensure a PR exists (open_pr outcome lane).
  {
    name: "review-by-colleague, no PR yet ⇒ [OpenPr]",
    card: mkCard({ lane: "review-by-colleague" }),
    journal: mkJournal(),
    obs: mkObs(),
    expected: [{ kind: "OpenPr", card: mkCard({ lane: "review-by-colleague" }) }],
  },
  {
    name: "review-by-colleague, PR already opened ⇒ NoOp",
    card: mkCard({ lane: "review-by-colleague" }),
    journal: mkJournal({ terminal: "pr_opened" }),
    obs: mkObs(),
    expected: [],
  },

  // user-questions ⇒ NoOp (human owns the lane; resume is a board drag).
  {
    name: "user-questions ⇒ NoOp",
    card: mkCard({ lane: "user-questions" }),
    journal: mkJournal(),
    obs: mkObs(),
    expected: [],
  },

  // completed / cancelled ⇒ NoOp (observe-only terminal; never written by us).
  {
    name: "completed ⇒ NoOp (observe-only terminal)",
    card: mkCard({ lane: "completed" }),
    journal: mkJournal(),
    obs: mkObs(),
    expected: [],
  },
  {
    name: "cancelled ⇒ NoOp (observe-only terminal)",
    card: mkCard({ lane: "cancelled" }),
    journal: mkJournal(),
    obs: mkObs(),
    expected: [],
  },

  // ready_to_merge custom col, !isMerged (merge_when_green + green) ⇒
  // Merge with expect=ready_to_merge (CAS guard).
  {
    name: "ready_to_merge, !merged (green) ⇒ [Merge expect=ready_to_merge]",
    card: mkCard({ lane: "review-by-user", customColumnId: READY_TO_MERGE }),
    journal: mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] }),
    obs: mkObs({ diffHash: "d1", merged: false }),
    expected: [
      {
        kind: "Merge",
        card: mkCard({ lane: "review-by-user", customColumnId: READY_TO_MERGE }),
        expect: READY_TO_MERGE,
      },
    ],
  },

  // ready_to_merge, isMerged already ⇒ NoOp (exactly-once).
  {
    name: "ready_to_merge, obs.merged ⇒ NoOp (exactly-once)",
    card: mkCard({ lane: "review-by-user", customColumnId: READY_TO_MERGE }),
    journal: mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] }),
    obs: mkObs({ diffHash: "d1", merged: true }),
    expected: [],
  },
  {
    name: "ready_to_merge, terminal=merged ⇒ NoOp (exactly-once)",
    card: mkCard({ lane: "review-by-user", customColumnId: READY_TO_MERGE }),
    journal: mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })], terminal: "merged" }),
    obs: mkObs({ diffHash: "d1", merged: false }),
    expected: [],
  },

  // ANY OTHER unmanaged custom column ⇒ [] (decide() exhaustive).
  {
    name: "unmanaged custom column ⇒ [] (NoOp)",
    card: mkCard({ lane: "in-progress", customColumnId: "some-other-col" }),
    journal: mkJournal(),
    obs: mkObs(),
    expected: [],
  },
];

describe("decide() — transition table (exact Action[])", () => {
  test.each(rows)("$name", ({ card, journal, obs, predicate, expected }) => {
    expect(decide(card, journal, mkPolicy(card.policy), obs, NOW, predicate)).toEqual(expected);
  });
});

// --- SendFixPrompt rows (assert kind + order + findings substring) --------

describe("decide() — fix-loop rows (SendFixPrompt)", () => {
  test("in-progress, last red, fix not yet sent ⇒ SendFixPrompt", () => {
    const c = mkCard({ lane: "in-progress" });
    const journal = mkJournal({
      attempts: [attempt({ outcome: "red", diffHash: "d1", failureSignature: "sig-7" })],
      consecutiveFailures: 1,
    });
    const actions = decide(c, journal, c.policy, mkObs({ diffHash: "d1" }), NOW);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("SendFixPrompt");
    const a = actions[0] as Extract<Action, { kind: "SendFixPrompt" }>;
    expect(a.card).toBe(c);
    expect(a.findings).toContain("Mechanical checks failed");
    expect(a.findings).toContain("sig-7");
  });

  test("review changes_requested, not yet rejected ⇒ [MoveLane→in-progress, SendFixPrompt]", () => {
    const c = mkCard({ lane: "review-by-ai" });
    // Head only passed checks (green) — the reviewer rejection has NOT been folded as a
    // red attempt yet, so the findings route back to the implementor.
    const journal = mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] });
    const obs = mkObs({
      diffHash: "d1",
      review: {
        verdict: "changes_requested",
        criteria: [],
        blocking: ["Handle the empty-list case"],
        ranChecks: true,
      },
    });
    const actions = decide(c, journal, c.policy, obs, NOW);

    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.kind)).toEqual(["MoveLane", "SendFixPrompt"]);
    const move = actions[0] as Extract<Action, { kind: "MoveLane" }>;
    expect(move.to).toBe("in-progress");
    expect(move.expect).toBe("review-by-ai"); // active→active; also no-ops the on-exit auto-advance
    const fix = actions[1] as Extract<Action, { kind: "SendFixPrompt" }>;
    expect(fix.findings).toContain("Handle the empty-list case");
  });
});

// --- out-of-band review mode --------------------------------------------
// dev3-loop runs its own reviewer; the card stays in in-progress and NEVER enters review-by-ai,
// so dev-3.0's fixer can't be triggered (double-review is structurally impossible).

describe("decide() — out-of-band review mode", () => {
  const oob = (over: Partial<CardPolicy> = {}): Card =>
    mkCard({ lane: "in-progress", policy: mkPolicy({ reviewMode: "out-of-band", ...over }) });

  test("green, no verdict, reviewer not launched ⇒ [LaunchGrader] (no review-by-ai move)", () => {
    const c = oob();
    const j = mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] });
    const actions = decide(c, j, c.policy, mkObs({ diffHash: "d1" }), NOW);
    expect(actions.map((a) => a.kind)).toEqual(["LaunchGrader"]);
  });

  test("green, no verdict, reviewer already launched ⇒ NoOp (awaiting verdict)", () => {
    const c = oob();
    const j = mkJournal({
      attempts: [attempt({ outcome: "green", diffHash: "d1", reviewerLaunched: true })],
    });
    expect(decide(c, j, c.policy, mkObs({ diffHash: "d1" }), NOW)).toEqual([]);
  });

  test("green, reviewer launched, stall predicate trips ⇒ GiveUp (hung reviewer still gives up)", () => {
    const c = oob();
    const j = mkJournal({
      attempts: [attempt({ outcome: "green", diffHash: "d1", reviewerLaunched: true })],
    });
    const actions = decide(c, j, c.policy, mkObs({ diffHash: "d1" }), NOW, stopWith("stall"));
    expect(actions).toEqual([{ kind: "GiveUp", card: c, reason: "stall" }]);
  });

  test("green + verdict pass ⇒ [MoveLane → review-by-user] (in-progress, never review-by-ai)", () => {
    const c = oob();
    const j = mkJournal({
      attempts: [attempt({ outcome: "green", diffHash: "d1", reviewerLaunched: true })],
    });
    const obs = mkObs({ diffHash: "d1", review: { verdict: "pass", criteria: [], blocking: [], ranChecks: true } });
    const actions = decide(c, j, c.policy, obs, NOW);
    expect(actions).toHaveLength(1);
    const move = actions[0] as Extract<Action, { kind: "MoveLane" }>;
    expect(move.kind).toBe("MoveLane");
    expect(move.to).toBe("review-by-user");
    expect(move.expect).toBe("in-progress");
  });

  test("green + verdict changes_requested ⇒ [SendFixPrompt] only, card stays in-progress (no move)", () => {
    const c = oob();
    const j = mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1", reviewerLaunched: true })] });
    const obs = mkObs({
      diffHash: "d1",
      review: { verdict: "changes_requested", criteria: [], blocking: ["Fix the off-by-one"], ranChecks: true },
    });
    const actions = decide(c, j, c.policy, obs, NOW);
    expect(actions.map((a) => a.kind)).toEqual(["SendFixPrompt"]);
    const fix = actions[0] as Extract<Action, { kind: "SendFixPrompt" }>;
    expect(fix.findings).toContain("Fix the off-by-one");
  });

  test("defensive: changes_requested over an already-rejected diff ⇒ NoOp (sticky verdict)", () => {
    const c = oob();
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "red", diffHash: "d1" }),
        attempt({ outcome: "green", diffHash: "d1", reviewerLaunched: true }),
      ],
    });
    const obs = mkObs({
      diffHash: "d1",
      review: { verdict: "changes_requested", criteria: [], blocking: ["x"], ranChecks: true },
    });
    expect(decide(c, j, c.policy, obs, NOW)).toEqual([]);
  });

  test("contrast: in-band green ⇒ moves to review-by-ai; out-of-band never does", () => {
    const inBand = mkCard({ lane: "in-progress", policy: mkPolicy({ reviewMode: "in-band" }) });
    const j = mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] });
    const inBandActions = decide(inBand, j, inBand.policy, mkObs({ diffHash: "d1" }), NOW);
    expect(inBandActions.map((a) => a.kind)).toEqual(["MoveLane", "LaunchGrader"]);
    expect((inBandActions[0] as Extract<Action, { kind: "MoveLane" }>).to).toBe("review-by-ai");

    const oobActions = decide(oob(), j, oob().policy, mkObs({ diffHash: "d1" }), NOW);
    expect(oobActions.some((a) => a.kind === "MoveLane")).toBe(false);
  });
});

// --- guardrail GiveUp wiring (here we only prove decide() routes) ---

describe("decide() — injected guardrail trips to GiveUp", () => {
  test("last red + predicate stops ⇒ GiveUp(reason)", () => {
    const c = mkCard({ lane: "in-progress" });
    const journal = mkJournal({ attempts: [attempt({ outcome: "red", diffHash: "d1" })] });
    const actions = decide(c, journal, c.policy, mkObs({ diffHash: "d1" }), NOW, stopWith("cap"));
    expect(actions).toEqual([{ kind: "GiveUp", card: c, reason: "cap" }]);
  });

  test("still-working + predicate stops ⇒ GiveUp(reason) (stall)", () => {
    const c = mkCard({ lane: "in-progress" });
    const actions = decide(c, mkJournal(), c.policy, mkObs(), NOW, stopWith("stall"));
    expect(actions).toEqual([{ kind: "GiveUp", card: c, reason: "stall" }]);
  });
});

// --- merge-policy dispatch (case 12) --------------------------------------

describe("mergeGateAction() — merge-policy dispatch", () => {
  test("open_pr ⇒ [OpenPr]", () => {
    expect(mergeGateAction(card, mkPolicy({ merge: "open_pr" }), mkJournal())).toEqual([
      { kind: "OpenPr", card },
    ]);
  });

  test("merge_when_green, last green ⇒ [Merge expect=ready_to_merge]", () => {
    const j = mkJournal({ attempts: [attempt({ outcome: "green", diffHash: "d1" })] });
    expect(mergeGateAction(card, mkPolicy({ merge: "merge_when_green" }), j)).toEqual([
      { kind: "Merge", card, expect: READY_TO_MERGE },
    ]);
  });

  test("merge_when_green, last NOT green ⇒ [] (defensive gate)", () => {
    const j = mkJournal({ attempts: [attempt({ outcome: "red", diffHash: "d1" })] });
    expect(mergeGateAction(card, mkPolicy({ merge: "merge_when_green" }), j)).toEqual([]);
  });

  test("fix_until_green_and_merge ⇒ [Merge expect=ready_to_merge]", () => {
    expect(mergeGateAction(card, mkPolicy({ merge: "fix_until_green_and_merge" }), mkJournal())).toEqual(
      [{ kind: "Merge", card, expect: READY_TO_MERGE }],
    );
  });
});

// --- human override (case 11) ---------------------------------------------

describe("applyHumanResume() — drag user-questions → in-progress", () => {
  test("resets consecutiveFailures AND clears terminal, preserves attempts", () => {
    const before = mkJournal({
      attempts: [attempt({ n: 1 }), attempt({ n: 2 }), attempt({ n: 3 })],
      consecutiveFailures: 2,
      totalTokens: 1234,
      terminal: "given_up",
    });
    const after = applyHumanResume(before);

    expect(after.consecutiveFailures).toBe(0); // reset
    expect(after.terminal).toBeUndefined(); // revived card not still given_up
    expect(after.attempts).toHaveLength(3); // totalAttempts history preserved
    expect(after.totalTokens).toBe(1234); // untouched
    expect("terminal" in after).toBe(false); // key dropped, not set to undefined
  });

  test("observed terminal lanes (cancelled/completed) are NoOp for decide()", () => {
    // A human drag to cancelled/completed is observed as terminal — decide() never
    // writes those lanes and proposes nothing.
    const lanes: Lane[] = ["cancelled", "completed"];
    for (const lane of lanes) {
      const c = mkCard({ lane });
      expect(decide(c, mkJournal({ terminal: "given_up" }), c.policy, mkObs(), NOW)).toEqual([]);
    }
  });
});
