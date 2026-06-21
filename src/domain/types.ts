/**
 * Domain model for dev3-loop.
 *
 * PURE module: types only, no runtime logic, no imports of adapters/IO.
 *
 * @module domain/types
 */

/**
 * The real dev-3.0 board statuses. These ARE the board column ids — do not
 * invent our own.
 *
 * `completed`/`cancelled` are **observe-only**: the dev-3.0 UI destroys the
 * worktree on entry, the CLI cannot set `cancelled`, and `completed` is a
 * blocking human approval. We **read** these states, never write them.
 */
export type Lane =
  | "todo" // backlog
  | "in-progress" // implementor working (also where fixes loop)
  | "user-questions" // blocked / parked for human (also our give-up lane)
  | "review-by-ai" // our reviewer runs here (reuses dev-3.0 column agent)
  | "review-by-user" // human gate (post-reviewer-pass)
  | "review-by-colleague" // "PR Review" lane — maps to open_pr policy
  | "completed" // observe-only terminal (human archives)
  | "cancelled"; // observe-only terminal (human cancels)

/**
 * Custom-column id (e.g. a no-agent `ready_to_merge` column) used as a merge
 * trigger. Reachable via `dev3 task move --status <customColumnId>`. A {@link Card}
 * is "in" a custom column when its {@link Card.customColumnId} is set (the
 * built-in {@link Card.lane} is then stale and must not be used for routing).
 */
export type CustomColumnId = string;

/**
 * How a card is taken across the human merge gate.
 */
export type MergePolicy =
  | "open_pr" // run → open PR → stop (human merges)
  | "merge_when_green" // run → checks green → auto-merge
  | "fix_until_green_and_merge"; // run → checks → on red, loop fixes → merge when green

/**
 * Identifies a dev-3.0 agent invocation (a registry entry).
 */
export interface AgentSpec {
  /** dev-3.0 agent id, e.g. "claude" | "codex" | "gemini" | "aider". */
  agent: string;
  /** dev-3.0 config id for that agent (model/profile), or undefined for default. */
  config?: string;
}

/**
 * Per-card policy: the merge strategy plus all guardrail caps and the
 * implementor/reviewer pairing. Resolved by `ConfigPort.policyFor(card)` from repo
 * defaults + per-card overrides.
 */
export interface CardPolicy {
  /** Merge strategy dispatched at the human gate. */
  merge: MergePolicy;
  /** Consecutive-failure cap before give-up (default 3). */
  maxConsecutiveFailures: number;
  /** Absolute attempt cap before give-up (default 6). */
  maxTotalAttempts: number;
  /** Heartbeat staleness threshold marking a stall, in ms (default 600_000 = 10 min). */
  stallMs: number;
  /** Optional per-card token cap; give up when exceeded. */
  tokenBudget?: number;
  /** The agent that writes code. */
  implementor: AgentSpec;
  /**
   * The independent reviewer. May share {@link CardPolicy.implementor}'s `agent` /
   * `config` (even the same model) — independence comes from the reviewer's
   * separate launch + read-only rubric prompt + re-running checks, not from a
   * distinct `(agent, config)`. A different model is recommended but not enforced.
   */
  reviewer: AgentSpec;
  /** Mechanical checks command run in the worktree, e.g. "bun run test && tsc --noEmit". */
  checksCmd: string;
}

/**
 * A single dev-3.0 task as observed by the reconciler (read-only projection of
 * the board store; we mutate only via the `dev3` CLI).
 */
export interface Card {
  /** dev-3.0 task uuid. */
  id: string;
  /** owner/name (derive from project; project.name as fallback). */
  repo: string;
  /** task.baseBranch (e.g. "main"). */
  baseBranch: string;
  /** dev-3.0 branch, deterministic: `dev3/task-<id8>`. */
  branch: string;
  /** task.worktreePath (null until dev-3.0 starts it). */
  worktreePath: string | null;
  /** task.status — the built-in lane. */
  lane: Lane;
  /** task.customColumnId — when set, overrides {@link Card.lane} for routing. */
  customColumnId?: string | null;
  /** task.description (markdown; there is no structured criteria field). */
  prompt: string;
  /** Parsed from the description, or [] ⇒ reviewer uses the full description. */
  acceptanceCriteria: string[];
  /** Resolved policy for this card. */
  policy: CardPolicy;
}

/**
 * Result of a single implementor/checks attempt.
 *
 * - `green`  — mechanical checks passed.
 * - `red`    — mechanical checks failed.
 * - `stalled`— no heartbeat within `stallMs` / session dead.
 * - `error`  — the attempt could not be evaluated (infra error).
 */
export type AttemptOutcome = "green" | "red" | "stalled" | "error";

/**
 * One row of a card's attempt history. Durable (lives in the journal on disk);
 * the orchestrator holds no essential state in RAM.
 */
export interface AttemptRecord {
  /** 1-based attempt index. */
  n: number;
  /** Outcome of this attempt. */
  outcome: AttemptOutcome;
  /** Hash of the failing-test set / normalized error (no-progress detection). */
  failureSignature?: string;
  /** Hash of the worktree diff (oscillation detection). */
  diffHash?: string;
  /** Tokens spent during this attempt, if known. */
  tokensSpent?: number;
  /** Epoch ms when the attempt started. */
  startedAt: number;
  /** Epoch ms when the attempt ended, if finished. */
  endedAt?: number;
  /**
   * True once the orchestrator has dispatched the `SendFixPrompt` for this (red)
   * attempt. The shell sets it when it sends the fix — both the mechanical-check
   * red path and when it folds a reviewer `changes_requested` rejection (which is
   * sent as part of the bounce). `decide()` reads it to deliver the fix **exactly
   * once per attempt** rather than re-sending every tick while the never-deleted
   * `.dev3/result.json` stays present (the sticky-result NoOp). Absent/false ⇒ not
   * yet sent — also the safe post-crash default, since a
   * re-send is harmless. Only meaningful on `red` attempts.
   */
  fixPromptSent?: boolean;
}

/**
 * Durable per-card bookkeeping (the journal) — the **single source of truth for
 * state**. Persisted atomically; a crash + restart resumes
 * from this alone (via its `pending` write-ahead + reality-checks). The NDJSON
 * event log is an audit trace, **not** a thing the journal is rebuilt from.
 */
export interface CardJournal {
  /** dev-3.0 task uuid this journal belongs to. */
  cardId: string;
  /** Full attempt history. */
  attempts: AttemptRecord[];
  /** Count since the last green (reset on green; reset on human resume). */
  consecutiveFailures: number;
  /** Cumulative tokens spent across attempts. */
  totalTokens: number;
  /** Epoch ms of the last observed heartbeat (stall detection). */
  lastHeartbeatAt?: number;
  /** Write-ahead markers for in-flight effectful actions, keyed by action id. */
  pending: Record<string, { kind: string; startedAt: number }>;
  /** Set once the card reaches a terminal outcome for the loop. */
  terminal?: "merged" | "pr_opened" | "given_up" | "cancelled";
}

/**
 * Pure result of `decide()`. Adapters interpret these; the domain never does
 * I/O. See the transition table for which lane/verdict yields which action.
 */
export type Action =
  /** Nothing to do this tick (still working, human gate, or terminal). */
  | { kind: "NoOp" }
  /** Spawn the implementor agent in the card's worktree (after promotion to in-progress). */
  | { kind: "LaunchProducer"; card: Card }
  /** Run the mechanical checks command in the worktree (the source of truth; never trust self-report). */
  | { kind: "RunChecks"; card: Card }
  /** Launch the independent, different-model, read-only reviewer. */
  | { kind: "LaunchGrader"; card: Card }
  /** Send fix findings back into the implementor's session so it keeps context. */
  | { kind: "SendFixPrompt"; card: Card; findings: string }
  /**
   * Move the card to a built-in {@link Lane} or a {@link CustomColumnId}.
   * `expect` is the lane/column we believe the card is in → the adapter issues a
   * guarded `--if-status <expect>` compare-and-set (server-enforced, race-free).
   * `note` is an optional human-facing note to attach with the move.
   */
  | { kind: "MoveLane"; card: Card; to: Lane | CustomColumnId; expect?: Lane | CustomColumnId; note?: string }
  /**
   * Merge the branch into base (push + `gh pr merge`); exactly-once, write-ahead
   * logged. `expect` is the lane/column we believe authorizes the merge (e.g.
   * `ready_to_merge`); the adapter re-verifies it AND `isMerged` immediately
   * before the irreversible push and no-ops if either changed — a CAS guard on
   * the highest-stakes action.
   */
  | { kind: "Merge"; card: Card; expect?: Lane | CustomColumnId }
  /** Open a pull request via the gh CLI (open_pr policy). */
  | { kind: "OpenPr"; card: Card }
  /** Abandon the card to the human (move to user-questions + diagnostic note) with a reason. */
  | { kind: "GiveUp"; card: Card; reason: string };
