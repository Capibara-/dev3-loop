/**
 * The reconcile state machine — `decide()`.
 *
 * PURE module: no I/O, no adapter imports. Given the durable journal, the resolved
 * policy, and a cheap {@link Observation} snapshot, it returns the **ordered**
 * {@link Action} list the imperative shell should execute this tick (`[]` = NoOp).
 * Every decision is re-derivable from durable state, so the loop is
 * level-triggered and crash-safe.
 *
 * Two pillars are encoded here:
 *  - **The implementor's self-report is never trusted.** A present `.dev3/result.json`
 *    with `status:"done"` triggers a `RunChecks` we run ourselves; `claimedTestsPass`
 *    is ignored. The green/red verdict comes from `journal.attempts` (the journaled
 *    result of a prior `RunChecks`), **never** from `obs`.
 *  - **The reviewer verdict drives routing, not the board lane.** dev-3.0's hardcoded
 *    on-exit hook may have force-advanced the card `review-by-ai → review-by-user`,
 *    so we route off `review.json` from **either** review lane.
 *
 * Guardrail caps (consecutive-failure / iteration / no-progress / oscillation /
 * stall / budget) are injected here as a single {@link GiveUpPredicate}
 * and **defaulted to {@link allowAll}** (never give up) — this module implements
 * none of that logic.
 *
 * @module domain/reconcile
 */

import type {
  Action,
  Card,
  CardJournal,
  CardPolicy,
  CustomColumnId,
  Lane,
} from "./types.ts";
import type { Review, Observation } from "../ports/dto.ts";

/**
 * Verdict of a guardrail give-up check. `stop:true` ⇒ abandon the card
 * to the human; `reason` is the diagnostic recorded on the {@link Action} kind
 * `"GiveUp"`.
 */
export interface GiveUpVerdict {
  stop: boolean;
  reason?: string;
}

/**
 * The guardrail give-up check, injected into {@link decide} (evaluated
 * before any fix re-prompt and while a card is still working). Ships only the
 * {@link allowAll} stub for now; the real predicate (caps, no-progress, oscillation,
 * stall, budget) lands later. It receives `obs` as well as the journal so stall /
 * dead-session detection has the inputs it needs (a superset of a plain
 * `(journal, policy, now)` signature).
 */
export type GiveUpPredicate = (
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
) => GiveUpVerdict;

/** The default give-up predicate: never give up (guardrails land later). */
export const allowAll: GiveUpPredicate = () => ({ stop: false });

/**
 * Well-known id of the no-agent **merge-trigger** custom column. Moving
 * a card here is the human's "merge it" signal. The real id is repo-configured;
 * we treat this conventional value as the trigger and leave
 * **every other** custom column untouched.
 */
export const READY_TO_MERGE: CustomColumnId = "ready_to_merge";

/** The empty action list — the canonical NoOp. */
const NOOP: Action[] = [];

/** Routing key: the card's custom column if set, else its built-in `lane` (a card in
 *  a custom column has a stale lane). Shared by decide() and the fleet pre-pass. */
export function routingKey(card: Card): Lane | CustomColumnId {
  return card.customColumnId && card.customColumnId.length > 0 ? card.customColumnId : card.lane;
}

/** Last journaled attempt, or `undefined` when the card has never been attempted. */
function lastAttempt(journal: CardJournal): CardJournal["attempts"][number] | undefined {
  return journal.attempts[journal.attempts.length - 1];
}

/** True iff some recorded attempt was over this exact diff (edge-detection). */
function attemptedDiff(journal: CardJournal, diffHash: string | undefined): boolean {
  return diffHash !== undefined && journal.attempts.some((a) => a.diffHash === diffHash);
}

/**
 * True iff a **rejection** (red attempt) was already recorded for this exact diff —
 * i.e. its `diffHash` has been "acted on" for the reviewer fix-loop. A head that
 * only passed checks has just a green attempt (not rejected yet); once the shell
 * folds the reviewer's `changes_requested` as a red `AttemptRecord` for that head,
 * this returns true and a sticky `review.json` stops re-sending the fix.
 */
function rejectedDiff(journal: CardJournal, diffHash: string | undefined): boolean {
  return (
    diffHash !== undefined &&
    journal.attempts.some((a) => a.diffHash === diffHash && a.outcome === "red")
  );
}

/** Build a `MoveLane`, omitting `expect`/`note` when absent (exactOptionalPropertyTypes). */
function moveLane(
  card: Card,
  to: Lane | CustomColumnId,
  expect?: Lane | CustomColumnId,
  note?: string,
): Action {
  const action: Extract<Action, { kind: "MoveLane" }> = { kind: "MoveLane", card, to };
  if (expect !== undefined) action.expect = expect;
  if (note !== undefined) action.note = note;
  return action;
}

/** Findings text for a implementor fix-loop after our mechanical checks went red. */
function checkFailureFindings(card: Card, journal: CardJournal): string {
  const last = lastAttempt(journal);
  const sig = last?.failureSignature ? ` (failure signature ${last.failureSignature})` : "";
  return (
    `Mechanical checks failed${sig}. Re-run \`${card.policy.checksCmd}\` in the ` +
    `worktree, fix the failing tests, then re-write .dev3/result.json when done.`
  );
}

/** Findings text routed back to the implementor when the reviewer requests changes. */
function graderFindings(review: Review): string {
  const blocking = review.blocking.length > 0 ? review.blocking : ["(reviewer requested changes)"];
  return `The independent reviewer requested changes:\n- ${blocking.join("\n- ")}`;
}

/**
 * Merge-gate dispatch on `policy.merge`. Returns the action(s) that take
 * a card across the human merge gate for the given policy. `expect` on `Merge` is
 * {@link READY_TO_MERGE}: the adapter re-verifies the column **and** `isMerged`
 * immediately before the irreversible push (CAS guard).
 */
export function mergeGateAction(card: Card, policy: CardPolicy, journal: CardJournal): Action[] {
  switch (policy.merge) {
    case "open_pr":
      // run → open PR → stop; the human merges on GitHub.
      return [{ kind: "OpenPr", card }];
    case "merge_when_green": {
      // Only auto-merge a checked-green head (defensive; the loop already gated it).
      if (lastAttempt(journal)?.outcome !== "green") return NOOP;
      return [{ kind: "Merge", card, expect: READY_TO_MERGE }];
    }
    case "fix_until_green_and_merge":
      // The in-progress/reviewer fix-loop already enforced green + reviewer-pass.
      return [{ kind: "Merge", card, expect: READY_TO_MERGE }];
    default:
      return assertNever(policy.merge);
  }
}

/**
 * Apply a human resume: dragging a card out of
 * `user-questions` back to `in-progress` means "blocker resolved, retry". Resets
 * `consecutiveFailures` and clears `journal.terminal` (so a deliberately-revived
 * card isn't still flagged `given_up`) while **preserving** the absolute attempt
 * history (`attempts`, the total-attempts cap input). Pure: returns a new journal.
 */
export function applyHumanResume(journal: CardJournal): CardJournal {
  const { terminal, ...rest } = journal;
  void terminal; // intentionally dropped
  return { ...rest, consecutiveFailures: 0 };
}

/**
 * The reconcile decision. Pure: `Action[]` only, no I/O. `[]` = NoOp.
 *
 * Routing key = the card's **custom column if set, else its built-in `lane`**.
 *
 * @param card     Read-only board projection.
 * @param journal  Durable per-card bookkeeping (the source of truth for state).
 * @param policy   Resolved per-card policy.
 * @param obs      Cheap side-effect-free snapshot; the check outcome is NOT
 *                 read from here — it comes from `journal.attempts`.
 * @param now      Epoch ms (from `ClockPort.now`).
 * @param shouldGiveUp  Guardrail predicate; defaults to {@link allowAll} (stub).
 */
export function decide(
  card: Card,
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
  shouldGiveUp: GiveUpPredicate = allowAll,
): Action[] {
  const key: Lane | CustomColumnId = routingKey(card);

  switch (key) {
    case "todo":
      // decide() always PROPOSES the promotion; the shell's fleet gate grants
      // or denies the slot. The MoveLane triggers dev-3.0's activateTask (worktree +
      // implementor); LaunchProducer is a no-op on the default in-band adapter.
      return [moveLane(card, "in-progress", "todo"), { kind: "LaunchProducer", card }];

    case "in-progress":
      return decideInProgress(card, journal, policy, obs, now, shouldGiveUp);

    case "review-by-ai":
    case "review-by-user":
      // Verdict-driven: route off review.json from EITHER review lane.
      return decideReview(key, card, journal, policy, obs, now, shouldGiveUp);

    case "review-by-colleague":
      // The open_pr outcome lane ("PR Review"): ensure the PR exists, then park.
      if (journal.terminal === "pr_opened") return NOOP;
      return [{ kind: "OpenPr", card }];

    case "user-questions":
      // Human owns this lane (blocked / given-up). Resume happens when they drag
      // the card back to in-progress (see applyHumanResume).
      return NOOP;

    case "completed":
    case "cancelled":
      // Observe-only terminal — never written by us.
      return NOOP;

    default:
      // A custom column. The merge-trigger is the only one we own.
      if (key === READY_TO_MERGE) {
        if (obs.merged || journal.terminal === "merged") return NOOP; // exactly-once
        return mergeGateAction(card, policy, journal);
      }
      return NOOP; // any other custom column is unmanaged — never touch it
  }
}

/** `in-progress` routing. */
function decideInProgress(
  card: Card,
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
  shouldGiveUp: GiveUpPredicate,
): Action[] {
  const triedThisDiff = attemptedDiff(journal, obs.diffHash);

  // 1. Implementor self-report present (its presence is the only thing we read from it).
  if (obs.result) {
    if (obs.result.status === "blocked") {
      // Human handoff — NOT a failure: don't run checks, don't touch the caps,
      // don't set terminal. Edge-detect by diffHash so a resumed card isn't
      // immediately re-parked.
      if (!triedThisDiff) {
        const note = obs.result.blockedQuestion ?? "Implementor reported blocked.";
        return [moveLane(card, "user-questions", "in-progress", note)];
      }
      return NOOP; // blocked already handled (sticky result.json)
    }

    // status === "done".
    if (obs.diffHash === undefined) {
      // Claims done but changed nothing vs base — degenerate.
      return [{ kind: "GiveUp", card, reason: "empty-diff" }];
    }
    if (!triedThisDiff) {
      // Never trust claimedTestsPass — run the checks ourselves.
      return [{ kind: "RunChecks", card }];
    }
    // This diff was already attempted: fall through to the journaled outcome —
    // the result.json is sticky and must not re-fire RunChecks.
  }

  // 2. Route off the last journaled attempt. The shell folds BOTH RunChecks results
  //    and reviewer verdicts into AttemptRecords, so a reviewer-rejected head reads as a
  //    red attempt here (which then drives the implementor fix-loop, not another review).
  const last = lastAttempt(journal);
  if (last?.outcome === "green") {
    // Green checks ⇒ hand to the independent reviewer. The MoveLane triggers dev-3.0's
    // column agent; LaunchGrader is a no-op on the default in-band adapter.
    return [moveLane(card, "review-by-ai", "in-progress"), { kind: "LaunchGrader", card }];
  }
  if (last?.outcome === "red") {
    // Guardrail (incl. the time-based stall) is re-evaluated EVERY tick, even while
    // we wait for the implementor — so a implementor that goes silent after the fix still
    // gives up correctly.
    const verdict = shouldGiveUp(journal, policy, obs, now);
    if (verdict.stop) return [{ kind: "GiveUp", card, reason: verdict.reason ?? "guardrail" }];
    // Deliver the fix exactly once per attempt. `result.json` is never deleted, so
    // without this we would re-send every tick while the implementor is mid-fix (the
    // sticky-result NoOp). A *new* red attempt — even over a
    // repeated diff — is a fresh fix opportunity, keeping this compatible with the
    // oscillation guardrail.
    if (last.fixPromptSent) return NOOP;
    return [{ kind: "SendFixPrompt", card, findings: checkFailureFindings(card, journal) }];
  }

  // 3. Still working (no actionable result / attempt). Stall is one of the injected
  //    give-up predicates; with the default stub we simply wait.
  const verdict = shouldGiveUp(journal, policy, obs, now);
  if (verdict.stop) return [{ kind: "GiveUp", card, reason: verdict.reason ?? "stall" }];
  return NOOP;
}

/** `review-by-ai` / `review-by-user` routing — verdict-driven. */
function decideReview(
  key: Lane,
  card: Card,
  journal: CardJournal,
  policy: CardPolicy,
  obs: Observation,
  now: number,
  shouldGiveUp: GiveUpPredicate,
): Action[] {
  const review = obs.review;
  if (!review) return NOOP; // reviewer still running / no verdict yet — human/reviewer gate

  if (review.verdict === "changes_requested") {
    // Edge-detect by diffHash: a rejection is "acted
    // on" once the shell has folded it as a red AttemptRecord for this head, so a
    // sticky review.json doesn't re-send. A head that only passed checks has just a
    // green attempt → not yet rejected → route the findings back.
    if (rejectedDiff(journal, obs.diffHash)) return NOOP;
    const verdict = shouldGiveUp(journal, policy, obs, now);
    if (verdict.stop) return [{ kind: "GiveUp", card, reason: verdict.reason ?? "guardrail" }];
    // Move active→active (dev-3.0 does NOT respawn) and route findings to the
    // still-alive implementor. `--if-status <key>` also no-ops dev-3.0's on-exit
    // auto-advance from review-by-ai.
    return [moveLane(card, "in-progress", key), { kind: "SendFixPrompt", card, findings: graderFindings(review) }];
  }

  // verdict === "pass".
  if (key === "review-by-ai") {
    // Hand to the human gate (or let dev-3.0's on-exit hook do the same move).
    // Merge-policy dispatch happens later, at the gate (see mergeGateAction).
    return [moveLane(card, "review-by-user", "review-by-ai")];
  }

  // review-by-user, pass: the human gate holds until they signal merge (by moving
  // the card to the ready_to_merge column / merge label — handled by the
  // custom-column route + mergeGateAction).
  return NOOP;
}

/** Exhaustiveness guard: a `never` here means a union member is unhandled. */
function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
