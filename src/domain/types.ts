// Domain model for dev3-loop. PURE: types only, no runtime logic, no adapter/IO imports.

// ---- Board lanes ----

// The real dev-3.0 board statuses — these ARE the column ids, don't invent our own.
// completed/cancelled are observe-only: the UI destroys the worktree on entry, the
// CLI can't set cancelled, and completed is a blocking human approval. We read them,
// never write them.
export type Lane =
  | "todo" // backlog
  | "in-progress" // implementor working (also where fixes loop)
  | "user-questions" // blocked / parked for human (also our give-up lane)
  | "review-by-ai" // our reviewer runs here (reuses dev-3.0 column agent)
  | "review-by-user" // human gate (post-reviewer-pass)
  | "review-by-colleague" // "PR Review" lane — maps to open_pr policy
  | "completed" // observe-only terminal (human archives)
  | "cancelled"; // observe-only terminal (human cancels)

// A no-agent merge-trigger column (e.g. `ready_to_merge`), reached via
// `dev3 task move --status <id>`. When a Card's customColumnId is set it overrides
// the built-in lane for routing (lane is then stale).
export type CustomColumnId = string;

// ---- Policy ----

export type MergePolicy =
  | "open_pr" // run → open PR → stop (human merges)
  | "merge_when_green" // run → checks green → auto-merge
  | "fix_until_green_and_merge"; // run → checks → on red, loop fixes → merge when green

export interface AgentSpec {
  agent: string; // dev-3.0 agent id, e.g. "claude" | "codex" | "gemini" | "aider"
  config?: string; // config id (model/profile), or undefined for default
}

export interface CardPolicy {
  merge: MergePolicy;
  maxConsecutiveFailures: number; // default 3
  maxTotalAttempts: number; // default 6
  stallMs: number; // heartbeat staleness ⇒ stall; default 600_000 (10 min)
  tokenBudget?: number; // per-card cap; give up when exceeded
  implementor: AgentSpec;
  // May share implementor's agent/config (even the same model) — independence comes
  // from the reviewer's separate launch + read-only rubric + re-running checks, not
  // from a distinct (agent, config). A different model is recommended, not enforced.
  reviewer: AgentSpec;
  checksCmd: string; // e.g. "bun run test && tsc --noEmit"
}

// ---- Data models ----

// Read-only projection of a dev-3.0 task; we mutate only via the `dev3` CLI.
export interface Card {
  id: string; // dev-3.0 task uuid
  repo: string; // owner/name (derive from project; project.name as fallback)
  baseBranch: string; // e.g. "main"
  branch: string; // deterministic: `dev3/task-<id8>`
  worktreePath: string | null; // null until dev-3.0 starts it
  lane: Lane;
  customColumnId?: string | null; // when set, overrides lane for routing
  prompt: string; // task.description (markdown; no structured criteria field)
  acceptanceCriteria: string[]; // parsed from description, or [] ⇒ reviewer uses full description
  policy: CardPolicy;
}

export type AttemptOutcome =
  | "green" // mechanical checks passed
  | "red" // mechanical checks failed
  | "stalled" // no heartbeat within stallMs / session dead
  | "error"; // attempt could not be evaluated (infra error)

export interface AttemptRecord {
  n: number; // 1-based attempt index
  outcome: AttemptOutcome;
  failureSignature?: string; // hash of failing-test set / normalized error (no-progress detection)
  diffHash?: string; // hash of worktree diff (oscillation detection)
  tokensSpent?: number;
  startedAt: number;
  endedAt?: number;
  // True once the shell dispatched this (red) attempt's SendFixPrompt — both the
  // mechanical-red path and a folded reviewer changes_requested. decide() reads it to
  // deliver the fix exactly once per attempt instead of re-sending every tick while the
  // never-deleted result.json stays present. Absent/false ⇒ not yet sent (also the safe
  // post-crash default; a re-send is harmless). Only meaningful on red attempts.
  fixPromptSent?: boolean;
}

// The single source of truth for state. Persisted atomically; a crash + restart resumes
// from this alone (via `pending` write-ahead + reality-checks). The NDJSON event log is
// an audit trace, NOT a thing the journal is rebuilt from.
export interface CardJournal {
  cardId: string;
  attempts: AttemptRecord[];
  consecutiveFailures: number; // reset on green and on human resume
  totalTokens: number;
  lastHeartbeatAt?: number;
  pending: Record<string, { kind: string; startedAt: number }>; // write-ahead markers, keyed by action id
  terminal?: "merged" | "pr_opened" | "given_up" | "cancelled";
}

// ---- Actions ----

// Pure result of decide(); adapters interpret these, the domain never does I/O.
// See the reconcile transition table for which lane/verdict yields which action.
export type Action =
  | { kind: "NoOp" }
  | { kind: "LaunchProducer"; card: Card }
  | { kind: "RunChecks"; card: Card }
  | { kind: "LaunchGrader"; card: Card }
  | { kind: "SendFixPrompt"; card: Card; findings: string }
  // expect = the lane/column we believe the card is in → adapter issues a guarded
  // `--if-status <expect>` compare-and-set (server-enforced, race-free).
  | { kind: "MoveLane"; card: Card; to: Lane | CustomColumnId; expect?: Lane | CustomColumnId; note?: string }
  // Exactly-once, write-ahead logged. expect = the lane/column we believe authorizes the
  // merge; the adapter re-verifies it AND isMerged immediately before the irreversible
  // push and no-ops if either changed — a CAS guard on the highest-stakes action.
  | { kind: "Merge"; card: Card; expect?: Lane | CustomColumnId }
  | { kind: "OpenPr"; card: Card }
  | { kind: "GiveUp"; card: Card; reason: string };
