/**
 * Guardrail predicate tests (Test 5).
 *
 * {@link guardrails} is PURE: a verdict derived from the durable journal + policy +
 * the cheap {@link Observation} + `now`. Each of the six predicates must trip on
 * **its own** fixture and **not** on a healthy one, the higher-precedence predicate
 * must win when several would fire, and the best-effort inputs (failure signature,
 * heartbeat, token budget) must **degrade gracefully** — never trip or skip
 * give-up on absence.
 */
import { describe, expect, test } from "vitest";
import { guardrails } from "../../src/domain/guardrails.ts";
import type { AttemptRecord, CardJournal, CardPolicy } from "../../src/domain/types.ts";
import type { Observation } from "../../src/ports/dto.ts";

// --- builders -------------------------------------------------------------

const NOW = 1_000_000;

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

let nextN = 1;
function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { n: nextN++, outcome: "red", startedAt: 0, ...over };
}

const EMPTY_OBS: Observation = { result: null, review: null, alive: true, merged: false };
function obsWith(over: Partial<Observation> = {}): Observation {
  return { ...EMPTY_OBS, ...over };
}

// --- healthy baseline never trips -----------------------------------------

describe("guardrails — healthy fleet", () => {
  test("a fresh / progressing journal never gives up", () => {
    expect(guardrails(mkJournal(), mkPolicy(), EMPTY_OBS, NOW)).toEqual({ stop: false });
    // A card mid-fix (1 red, below caps, distinct diffs) keeps going.
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "red", diffHash: "aaa", failureSignature: "s1" }),
        attempt({ outcome: "red", diffHash: "bbb", failureSignature: "s2" }),
      ],
      consecutiveFailures: 2,
    });
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({ stop: false });
  });
});

// --- 1. consecutive-failure cap -------------------------------------------

describe("guardrails — consecutive-failure cap", () => {
  test("trips at the cap, not below; resets on green keeps it from tripping", () => {
    const policy = mkPolicy({ maxConsecutiveFailures: 3 });
    expect(guardrails(mkJournal({ consecutiveFailures: 2 }), policy, EMPTY_OBS, NOW)).toEqual({
      stop: false,
    });
    expect(guardrails(mkJournal({ consecutiveFailures: 3 }), policy, EMPTY_OBS, NOW)).toEqual({
      stop: true,
      reason: "consecutive-failures",
    });
    // A green reset (consecutiveFailures back to 0) does not trip even with history.
    const reset = mkJournal({
      attempts: [attempt({ outcome: "red" }), attempt({ outcome: "green" })],
      consecutiveFailures: 0,
    });
    expect(guardrails(reset, policy, EMPTY_OBS, NOW)).toEqual({ stop: false });
  });
});

// --- 2. absolute-iteration cap --------------------------------------------

describe("guardrails — max-attempts cap", () => {
  test("trips at maxTotalAttempts regardless of outcome, not below", () => {
    const policy = mkPolicy({ maxTotalAttempts: 6 });
    // 6 GREEN attempts with distinct diffs ⇒ only the iteration cap can fire.
    const sixGreen = mkJournal({
      attempts: Array.from({ length: 6 }, (_, i) =>
        attempt({ outcome: "green", diffHash: `d${i}` }),
      ),
    });
    expect(guardrails(sixGreen, policy, EMPTY_OBS, NOW)).toEqual({
      stop: true,
      reason: "max-attempts",
    });
    const fiveGreen = mkJournal({
      attempts: Array.from({ length: 5 }, (_, i) =>
        attempt({ outcome: "green", diffHash: `e${i}` }),
      ),
    });
    expect(guardrails(fiveGreen, policy, EMPTY_OBS, NOW)).toEqual({ stop: false });
  });
});

// --- 3. no-progress (failure signature) -----------------------------------

describe("guardrails — no-progress", () => {
  test("trips when the last 2 red attempts share a signature", () => {
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "red", diffHash: "aaa", failureSignature: "same" }),
        attempt({ outcome: "red", diffHash: "bbb", failureSignature: "same" }),
      ],
      consecutiveFailures: 2, // below the cap, so no-progress is the reason
    });
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({
      stop: true,
      reason: "no-progress",
    });
  });

  test("does NOT trip when signatures differ", () => {
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "red", diffHash: "aaa", failureSignature: "s1" }),
        attempt({ outcome: "red", diffHash: "bbb", failureSignature: "s2" }),
      ],
      consecutiveFailures: 2,
    });
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({ stop: false });
  });

  test("degrades gracefully: a missing signature neither trips nor skips give-up", () => {
    // Two reds, the most recent has NO signature ⇒ no-progress can't fire...
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "red", diffHash: "aaa", failureSignature: "same" }),
        attempt({ outcome: "red", diffHash: "bbb" }), // undefined signature
      ],
      consecutiveFailures: 2,
    });
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({ stop: false });
    // ...but the always-present caps still apply (consecutiveFailures hits 3 here).
    expect(guardrails({ ...j, consecutiveFailures: 3 }, mkPolicy(), EMPTY_OBS, NOW)).toEqual({
      stop: true,
      reason: "consecutive-failures",
    });
  });
});

// --- 4. oscillation (diff hash) -------------------------------------------

describe("guardrails — oscillation", () => {
  test("trips when a diffHash recurs after a different diff intervened", () => {
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "red", diffHash: "X" }),
        attempt({ outcome: "red", diffHash: "Y" }),
        attempt({ outcome: "red", diffHash: "X" }), // back to X ⇒ cycling
      ],
      consecutiveFailures: 1, // keep caps quiet so oscillation is the reason
    });
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({
      stop: true,
      reason: "oscillation",
    });
  });

  test("does NOT trip on CONSECUTIVE identical hashes (same head: green then reviewer-red)", () => {
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "green", diffHash: "X" }),
        attempt({ outcome: "red", diffHash: "X" }), // same head, reviewer changes_requested
      ],
      consecutiveFailures: 1,
    });
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({ stop: false });
  });

  test("does NOT trip on a normal monotonic fix sequence (all distinct)", () => {
    const j = mkJournal({
      attempts: [
        attempt({ outcome: "red", diffHash: "X" }),
        attempt({ outcome: "red", diffHash: "Y" }),
      ],
      consecutiveFailures: 2,
    });
    // distinct signatures so no-progress stays quiet too
    j.attempts[0]!.failureSignature = "s1";
    j.attempts[1]!.failureSignature = "s2";
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({ stop: false });
  });
});

// --- 5. stall -------------------------------------------------------------

describe("guardrails — stall", () => {
  test("trips when now − heartbeat exceeds stallMs (obs heartbeat)", () => {
    const policy = mkPolicy({ stallMs: 600_000 });
    const stale = obsWith({ heartbeatAt: NOW - 600_001 });
    expect(guardrails(mkJournal(), policy, stale, NOW)).toEqual({ stop: true, reason: "stall" });
    const fresh = obsWith({ heartbeatAt: NOW - 599_999 });
    expect(guardrails(mkJournal(), policy, fresh, NOW)).toEqual({ stop: false });
  });

  test("falls back to the journaled heartbeat when obs has none", () => {
    const policy = mkPolicy({ stallMs: 600_000 });
    const j = mkJournal({ lastHeartbeatAt: NOW - 700_000 });
    expect(guardrails(j, policy, EMPTY_OBS, NOW)).toEqual({ stop: true, reason: "stall" });
  });

  test("degrades gracefully: no heartbeat anywhere ⇒ never trips", () => {
    expect(guardrails(mkJournal(), mkPolicy(), EMPTY_OBS, NOW)).toEqual({ stop: false });
  });
});

// --- 6. per-card token budget ---------------------------------------------

describe("guardrails — token budget", () => {
  test("trips strictly above the budget, not at it", () => {
    const policy = mkPolicy({ tokenBudget: 100 });
    expect(guardrails(mkJournal({ totalTokens: 101 }), policy, EMPTY_OBS, NOW)).toEqual({
      stop: true,
      reason: "budget",
    });
    expect(guardrails(mkJournal({ totalTokens: 100 }), policy, EMPTY_OBS, NOW)).toEqual({
      stop: false,
    });
  });

  test("inert when no tokenBudget is configured", () => {
    expect(guardrails(mkJournal({ totalTokens: 1_000_000 }), mkPolicy(), EMPTY_OBS, NOW)).toEqual({
      stop: false,
    });
  });
});

// --- precedence -----------------------------------------------------------

describe("guardrails — precedence", () => {
  test("the higher-precedence predicate wins when several would trip", () => {
    // consecutiveFailures (cap) AND max-attempts AND oscillation all hold;
    // consecutive-failures is checked first.
    const j = mkJournal({
      attempts: Array.from({ length: 6 }, (_, i) =>
        attempt({ outcome: "red", diffHash: i % 2 === 0 ? "X" : "Y" }),
      ),
      consecutiveFailures: 6,
    });
    expect(guardrails(j, mkPolicy(), EMPTY_OBS, NOW)).toEqual({
      stop: true,
      reason: "consecutive-failures",
    });
  });
});
