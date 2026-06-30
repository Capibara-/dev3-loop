// Data transfer objects exchanged across the port seams. PURE: types only.
// Covers adapter→domain results (CheckResult/MergeResult/PrResult), the on-disk
// contracts the implementor/reviewer agents write inside the worktree
// (ImplementorResult = .dev3/result.json, Review = .dev3/review.json), the
// event-log record (LoopEvent), and the per-tick Observation snapshot.

import type { Action } from "../domain/types.ts";

// ---- Adapter results ----

// Outcome of the mechanical checks command (GitPort.runChecks). This — never the
// implementor's self-report — is the source of truth for green/red.
export interface CheckResult {
  passed: boolean; // true iff the command exited 0
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  // Sorted failing-test ids when extractable; the stable hash of this set is the
  // failureSignature for no-progress detection. undefined when none could be parsed.
  failingTests?: string[];
}

// alreadyMerged makes merge idempotent: a write-ahead crash between intent and done
// is reconciled by re-checking, not blind retry. Under `gh pr merge --auto` merge is
// *initiate*, not done — GitHub merges later, once its own required checks pass — so
// `pending` distinguishes a successfully-armed async merge (re-poll, NOT a failure)
// from a hard failure (which carries `message`).
export interface MergeResult {
  merged: boolean; // now merged, whether by this call or a prior one
  alreadyMerged: boolean; // already merged before this call (exactly-once guard)
  pending?: boolean; // initiated server-side (auto-merge armed); completion is async
  commit?: string; // resulting merge/HEAD commit on base, when known
  message?: string; // fast-forward vs no-ff, or failure reason
}

// alreadyExisted keeps PR creation idempotent across ticks.
export interface PrResult {
  url: string;
  number?: number;
  alreadyExisted: boolean; // an open PR for this branch already existed
}

// ---- Agent-written status files ----

// `.dev3/result.json` — the implementor's done-signal. claimedTestsPass is never
// trusted; the reconciler re-runs the checks regardless.
export interface ImplementorResult {
  status: "done" | "blocked"; // done ⇒ ready for checks; blocked ⇒ needs human input
  summary: string;
  blockedQuestion: string | null; // set iff status === "blocked"
  claimedTestsPass: boolean; // untrusted
}

export interface ReviewCriterion {
  criterion: string;
  met: boolean;
  note: string;
}

// `.dev3/review.json` — the independent reviewer's verdict. The verdict, NOT the
// board lane, drives routing in decide(), because dev-3.0's on-exit hook may
// force-advance the card before we read it.
export interface Review {
  verdict: "pass" | "changes_requested"; // pass ⇒ human gate; changes_requested ⇒ loop a fix
  criteria: ReviewCriterion[];
  blocking: string[]; // non-empty iff verdict === "changes_requested"
  ranChecks: boolean;
}

// ---- Event log ----

export type LoopEventType =
  | "intent" // written BEFORE an effectful action runs (write-ahead)
  | "done" // written after it succeeds; pairs with an intent by actionId
  | "lane_move" // a board lane/column transition was issued
  | "guardrail_trip" // a guardrail predicate fired (give-up)
  | "breaker_open"; // the fleet circuit breaker opened

// One record in the append-only event log (${stateDir}/events.ndjson). An
// audit/observability trace (powers `replay`) — NOT a source of truth: the journal
// is authoritative and is not rebuilt from these.
export interface LoopEvent {
  ts: number; // epoch ms (from ClockPort.now)
  cardId: string;
  type: LoopEventType;
  action?: Action["kind"]; // for intent/done
  actionId?: string; // correlates an intent with its done; mirrors CardJournal.pending keys
  detail?: Record<string, unknown>; // reason, target lane, signature, spend, …
}

// ---- Observation ----

// The cheap, side-effect-free snapshot the shell gathers each tick and hands to
// decide(). Reads only (idempotent): never runs the checks command, never mutates.
// Gathered lane-gated — skip terminal/todo cards, never blind-probe tmux
// (capture-pane hangs on control-mode sessions), timeout-guard every read.
//
// NOT here, on purpose:
//  - the green/red check outcome — that is the journaled result of a RunChecks Action,
//    read back from journal.attempts next tick, never a per-tick read;
//  - fleet slot availability — a promotion budget the shell spends sequentially, not
//    a per-card field.
//
// Lives here (not domain/types.ts) to avoid an import cycle: this module already
// imports Action from there, and reconcile.ts imports this.
export interface Observation {
  result: ImplementorResult | null; // .dev3/result.json, or null if absent/unparseable
  review: Review | null; // .dev3/review.json, or null if absent/unparseable
  alive: boolean; // the card's tmux session/pane still exists
  merged: boolean; // branch already merged into base (exactly-once guard)
  heartbeatAt?: number; // latest activity (terminal-preview delta / worktree mtime) — stall calc
  // Hash of the current base...branch diff: the edge-detector that stops the loop
  // re-firing on a sticky result.json, plus the oscillation signal. Absent ⇒ empty diff
  // (no changes vs base): a present result.json over an absent diffHash is the
  // degenerate "done but changed nothing" → give up.
  diffHash?: string;
}
