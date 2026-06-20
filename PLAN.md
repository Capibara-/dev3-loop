# dev3-loop — build plan for Claude Code

> A headless **reconciler** that wraps the [`dev-3.0`](https://github.com/h0x91b/dev-3.0)
> Kanban board to run autonomous, human-in-the-middle agentic coding loops:
> **start → validate → independent grade → (fix-loop) → human gate → merge/deploy**.
> dev-3.0 keeps doing what it's good at (worktree + tmux isolation per card, human
> review lanes). This service supplies the autonomy dev-3.0 deliberately leaves out.

---

## 0. How to use this document (read first, Claude Code)

- Build **incrementally, test-first, milestone by milestone** (see §16). Each milestone must be green (`tsc --noEmit` clean + `vitest` passing) before starting the next.
- The entire core (domain, reconciler, guardrails, persistence) is built against **in-memory fake ports** and must be fully tested **without** a running dev-3.0, tmux, or git. The real adapters come last.
- There are exactly **two external unknowns** (the `dev3` CLI subcommands and the JSON store path — see §18). **Do not guess them silently.** Isolate them behind the ports in §5, ship a documented `Fake*` and a `Dev3*` adapter with the assumptions marked `// DISCOVERY:`, and surface the open questions in the README.
- Prefer the smallest dependency set. Use Bun's built-ins (`Bun.spawn`, `Bun.file`, `Bun.write`) for process and file I/O. Only third-party dev dep is the test runner.
- Treat this as a hexagonal (ports & adapters) design. The domain core must not import any adapter, tmux, git, or `dev3` code directly — only port interfaces.

---

## 1. What we're building

dev-3.0 is human-driven by design: a person drags cards between columns, and each move into an active column makes dev-3.0 spin up a git worktree + tmux session running a coding agent. It has **no event bus, no MCP surface, no autonomous execution** — its automation seams are (a) a scriptable `dev3` CLI, (b) JSON state on disk, (c) tmux sessions you can read with `capture-pane` and drive with `send-keys`, and (d) a terminal-bell "needs attention" signal.

`dev3-loop` is a long-running process that uses the board's **columns as a state machine** and reconciles each card toward done: launch the producer, run mechanical checks, invoke a **separate** grader agent, loop fixes under strict guardrails, park at a human gate, then merge per a per-card policy. It is the "bind autonomous execution + merge automation to the runtime layer" step that boards like crabfleet declare as policy but leave unimplemented.

### Positioning vs. dev-3.0's built-ins (post-discovery)

Source review (see `DISCOVERY.md`) showed dev-3.0 already ships *rudimentary*
versions of two things this plan once assumed we'd build from scratch:

- an **`review-by-ai` column agent** that auto-runs on entry and self-hands-back, and
- **merge/PR** (`mergeTask`, `createPullRequest`, …) — though only over its
  socket RPC, not the `dev3` CLI, plus a `review-by-colleague` ("PR Review") lane.

So dev3-loop is **not** "add AI review + merge to dev-3.0." It is the
**rigorous, autonomous, recoverable reconciler** dev-3.0 deliberately lacks:
*independent, different-model, read-only grading with a structured verdict*;
*mechanical checks as the source of truth*; the *guardrail / cap / oscillation /
budget safety net*; *write-ahead, exactly-once merge*; *level-triggered
convergence*; and *policy-driven progression*. We **reuse** dev-3.0's
`review-by-ai` lane as the launch mechanism for our grader (configured to a
different model + read-only rubric prompt — see §8) rather than reimplementing
agent launch, and we keep the option to grade out-of-band behind `RuntimePort`.

---

## 2. Hard constraints (non-negotiable)

1. **Stack = dev-3.0's:** Bun runtime, TypeScript (strict), `vitest` for tests, `tsc --noEmit` as the type-check/lint gate, tmux + git invoked as child processes, plain JSON + NDJSON on disk. No DB, no web framework, no ORM. Headless (no Electrobun/UI).
2. **The board JSON is READ-ONLY to us.** Detect state by reading/​watching it; **mutate only through the `dev3` CLI**. Two writers to one JSON file = corruption.
3. **Level-triggered reconciliation is the source of truth.** `fs.watch` is allowed only as a latency optimization; correctness must come from a periodic full reconcile that re-derives all actions from durable state. Watch events lost during downtime must never cause divergence.
4. **All effectful actions are idempotent and write-ahead logged.** Record intent before acting, completion after; on restart, intent-without-completion triggers a *reconcile-and-verify*, never a blind retry. `merge` must be exactly-once.
5. **The orchestrator holds no essential state in RAM.** Counters, attempt history, spend, and signatures live on disk (journal). A crash + restart resumes correctly.
6. **Producer ≠ grader.** The grading agent is a *different* invocation, fresh context, ideally a *different model*, fed only the diff + criteria + check output — never the producer's conversation. It is read-only (never edits code).
7. **"Done" means a merge commit in git**, not a status file and not a board column. Status files and columns are *claims*; git is the unfakeable record.
8. **Guardrails are safety nets, never the success criterion.** Normal termination = mechanical-green AND grader-pass. Caps exist to bound the abnormal path.

---

## 3. Architecture

Hexagonal. A pure **domain core** (no I/O) plus **ports** (interfaces) implemented by **adapters** (the only code that touches dev-3.0 / tmux / git / fs).

```
                  ┌───────────────────────────────────────────┐
                  │                domain core                 │
                  │  reconciler · state machine · guardrails   │
                  │  policy eval · grader orchestration        │
                  │        (pure, no I/O, fully unit-tested)   │
                  └───────────────▲───────────────▲────────────┘
                                  │ ports          │ ports
        ┌─────────────────────────┴───┐   ┌────────┴───────────────────┐
        │ BoardPort / RuntimePort      │   │ JournalPort / EventLogPort │
        │ GitPort / ClockPort          │   │ ConfigPort                 │
        └──────────────▲───────────────┘   └────────────▲───────────────┘
                       │ adapters                         │ adapters
   Dev3CliBoard · TmuxRuntime · GitCli · SystemClock · FsJournal · NdjsonEventLog
                       ▲
                       │ (tests use Fake* adapters — no real I/O)
```

The **reconcile loop** (the heart):

```
loop forever:
  tick():
    cards   = boardPort.listCards()          // observed desired state (human can edit)
    journal = journalPort.loadAll()           // our durable bookkeeping
    for card in cards:
      desired = decide(card, journal[card.id])   // PURE: returns an Action
      if desired is not NoOp:
        eventLog.append(intent(desired))         // write-ahead
        execute(desired)                          // idempotent adapter calls
        eventLog.append(done(desired))
        journalPort.persist(updated bookkeeping)
    sleep(tickInterval)   // fs.watch can wake us early; full reconcile still runs
```

`decide()` is pure and exhaustively unit-tested. `execute()` is the only thing that performs I/O.

---

## 4. Domain model (`src/domain/types.ts`)

```ts
// Real dev-3.0 statuses (see DISCOVERY.md §Q1/Q2-bis). These ARE the board
// column ids — do not invent our own. `completed`/`cancelled` are observe-only
// (UI destroys the worktree; CLI can't set `cancelled`, and `completed` is a
// blocking human approval) — we read them, never write them.
export type Lane =
  | "todo"               // backlog
  | "in-progress"        // producer working (also where fixes loop)
  | "user-questions"     // blocked / parked for human (also our give-up lane)
  | "review-by-ai"       // our grader runs here (reuses dev-3.0 column agent, §8)
  | "review-by-user"     // human gate (post-grader-pass)
  | "review-by-colleague"// "PR Review" lane — maps to open_pr policy
  | "completed"          // observe-only terminal (human archives)
  | "cancelled";         // observe-only terminal (human cancels)

/** Custom-column id (e.g. a no-agent `ready_to_merge` column) used as a merge
 *  trigger. Reachable via `dev3 task move --status <customColumnId>`. A Card is
 *  "in" a custom column when its `customColumnId` is set (status is then stale).*/
export type CustomColumnId = string;

export type MergePolicy =
  | "open_pr"                  // run → open PR → stop (human merges)
  | "merge_when_green"         // run → checks green → auto-merge
  | "fix_until_green_and_merge"; // run → checks → on red, loop fixes → merge when green

export interface AgentSpec {
  /** dev-3.0 agent id, e.g. "claude" | "codex" | "gemini" | "aider" */
  agent: string;
  /** dev-3.0 config id for that agent (model/profile), or undefined for default */
  config?: string;
}

export interface CardPolicy {
  merge: MergePolicy;
  maxConsecutiveFailures: number; // default 3
  maxTotalAttempts: number;       // default 6
  stallMs: number;                // default 600_000 (10 min)
  tokenBudget?: number;           // per-card cap (optional)
  producer: AgentSpec;
  grader: AgentSpec;              // MUST differ from producer.agent OR producer.config
  checksCmd: string;             // e.g. "bun run test && tsc --noEmit"
}

export interface Card {
  id: string;              // dev-3.0 task uuid
  repo: string;            // owner/name (derive from project; project.name as fallback)
  baseBranch: string;      // task.baseBranch (e.g. "main")
  branch: string;          // dev-3.0 branch, deterministic: `dev3/task-<id8>`
  worktreePath: string;    // task.worktreePath (null until dev-3.0 starts it)
  lane: Lane;              // task.status
  customColumnId?: string | null; // task.customColumnId — set ⇒ overrides lane for routing
  prompt: string;          // task.description (markdown; no structured criteria field)
  acceptanceCriteria: string[]; // parsed from description, or [] ⇒ grader uses full description
  policy: CardPolicy;
}

export type AttemptOutcome = "green" | "red" | "stalled" | "error";

export interface AttemptRecord {
  n: number;
  outcome: AttemptOutcome;
  failureSignature?: string; // hash of failing-test set / normalized error
  diffHash?: string;         // hash of worktree diff (oscillation detection)
  tokensSpent?: number;
  startedAt: number;
  endedAt?: number;
}

export interface CardJournal {
  cardId: string;
  attempts: AttemptRecord[];
  consecutiveFailures: number;
  totalTokens: number;
  lastHeartbeatAt?: number;
  /** write-ahead markers for in-flight effectful actions, keyed by action id */
  pending: Record<string, { kind: string; startedAt: number }>;
  terminal?: "merged" | "pr_opened" | "given_up" | "cancelled";
}

/** Pure result of decide(). Adapters interpret these; the domain never does I/O. */
export type Action =
  | { kind: "NoOp" }
  | { kind: "LaunchProducer"; card: Card }
  | { kind: "RunChecks"; card: Card }
  | { kind: "LaunchGrader"; card: Card }
  | { kind: "SendFixPrompt"; card: Card; findings: string }
  | { kind: "MoveLane"; card: Card; to: Lane | CustomColumnId; expect?: Lane; note?: string }
  | { kind: "Merge"; card: Card }
  | { kind: "OpenPr"; card: Card }
  | { kind: "GiveUp"; card: Card; reason: string };
```

---

## 5. Ports (`src/ports/*.ts`) — the dev-3.0 seams

Keep these tiny. Each has a `Fake*` (in-memory, for tests) and a real adapter.

```ts
export interface BoardPort {
  // Reads join projects.json + data/<slug>/tasks.json directly (read-only);
  // `tasks list` CLI has no real --json. DISCOVERY §Q1/Q2.
  listCards(): Promise<Card[]>;
  /** Move to a built-in status OR a customColumnId, guarded by an optional
   *  expected-current status (→ `dev3 task move --status <to> --if-status
   *  <expect>`), giving server-enforced compare-and-set. DISCOVERY §Q2-bis. */
  moveCard(id: string, to: Lane | CustomColumnId, expect?: Lane): Promise<void>;
  addNote(id: string, note: string): Promise<void>;     // `dev3 note add` (@file for long)
  setOverview(id: string, text: string): Promise<void>; // `dev3 overview set` — live counters on card
  watch?(onChange: () => void): () => void;             // optional fs.watch; returns disposer
}

export interface RuntimePort {                  // tmux + worktree driver
  launchProducer(card: Card, spec: AgentSpec, prompt: string): Promise<void>;
  /** Launch the independent grader. Default adapter = move to `review-by-ai`
   *  with overridden builtinColumnAgents (§8); swappable for out-of-band. */
  launchGrader(card: Card, spec: AgentSpec, prompt: string): Promise<void>;
  sendFixPrompt(card: Card, text: string): Promise<void>; // into producer's pane
  /** server-mediated pane read (getTerminalPreview RPC); timeout-guarded. §Q3 */
  capture(card: Card): Promise<string | null>;
  isAlive(card: Card): Promise<boolean>;        // session/pane exists
  /** read a status file the agent wrote inside the worktree, or null */
  readResult(card: Card): Promise<ProducerResult | null>;   // .dev3/result.json
  readReview(card: Card): Promise<GraderReview | null>;     // .dev3/review.json
}

export interface GitPort {
  diff(card: Card): Promise<string>;            // base...branch
  runChecks(card: Card, cmd: string): Promise<CheckResult>; // in worktree
  isMerged(card: Card): Promise<boolean>;       // idempotency check
  merge(card: Card): Promise<MergeResult>;      // fast-forward/no-ff into base, push
  openPr(card: Card): Promise<PrResult>;        // gh CLI
}

export interface JournalPort {
  loadAll(): Promise<Record<string, CardJournal>>;
  persist(j: CardJournal): Promise<void>;       // atomic write (tmp + rename)
}

export interface EventLogPort { append(event: LoopEvent): Promise<void>; }
export interface ClockPort { now(): number; }
export interface ConfigPort { policyFor(card: Card): Promise<CardPolicy>; }
```

`CheckResult`, `MergeResult`, `PrResult`, `ProducerResult`, `GraderReview`, `LoopEvent` defined in `src/ports/dto.ts` (schemas in §11).

---

## 6. The reconcile algorithm (`src/domain/reconcile.ts`)

`decide(card, journal, policy, now): Action` — pure. Routing key = the card's
**custom column if set, else its `lane`**. Critically, the grader **verdict
(`review.json`) is authoritative, not the lane** — because dev-3.0's hardcoded
on-exit hook force-advances `review-by-ai → review-by-user` on a clean grader
exit (DISCOVERY §Q5). So `decide()` reads the verdict and routes regardless of
whether the card is still in `review-by-ai` or already nudged to `review-by-user`.
All `MoveLane` actions carry an `expect` (the lane we believe the card is in) so
the adapter can issue a guarded `--if-status` compare-and-set move.

| Routing key | Condition | Action |
|---|---|---|
| `todo` | fleet slot free (§7) | `MoveLane → in-progress` (dev-3.0 spawns worktree+agent) then `LaunchProducer` |
| `todo` | no slot | `NoOp` (fleet cap holds promotion) |
| `in-progress` | no `result.json`, within `stallMs`, alive | `NoOp` (still working) |
| `in-progress` | stalled (heartbeat > `stallMs`) / dead | `GiveUp("stall")` → `MoveLane → user-questions` |
| `in-progress` | `result.json` present | `RunChecks` (never trust `claimedTestsPass`) |
| `in-progress` | checks **red** & guardrails allow | record red; `SendFixPrompt(findings)` (stay) |
| `in-progress` | checks **red** & guardrail trips | `GiveUp(reason)` → `MoveLane → user-questions` |
| `in-progress` | checks **green** | `MoveLane → review-by-ai` then `LaunchGrader` (§8) |
| `review-by-ai` / `review-by-user` | no `review.json` yet, grader alive | `NoOp` |
| `review-by-ai` / `review-by-user` | `review.json`=`changes_requested` & guardrails allow | record red; `MoveLane → in-progress` + `SendFixPrompt` (this also no-ops the on-exit auto-advance via the `--if-status review-by-ai` guard) |
| `review-by-ai` / `review-by-user` | `review.json`=`changes_requested` & guardrail trips | `GiveUp(reason)` → `MoveLane → user-questions` |
| `review-by-ai` | `review.json`=`pass` | `MoveLane → review-by-user` (let the human gate hold; or let the on-exit hook do it) |
| `review-by-user` | `review.json`=`pass`, human hasn't acted | `NoOp` (human gate) |
| `review-by-user` | human signalled merge (moved to `ready_to_merge` custom col, or merge label) | dispatch on `policy.merge` (below) |
| `review-by-colleague` | — | treated as the `open_pr` outcome lane: ensure PR exists, then `NoOp` |
| `ready_to_merge`* (custom col) | `!isMerged` | `Merge` (guarded), then `addNote` result; leave human to archive |
| `ready_to_merge`* (custom col) | `isMerged` already | `NoOp` (exactly-once) |
| `completed` / `cancelled` | — | `NoOp` (observe-only terminal; never written by us) |

\* `ready_to_merge` is a **custom column with no `agentConfig`** (so entering it
launches no agent). One-time setup (GUI/RPC; no CLI verb to *create* it). The
loop moves a card in via `dev3 task move --status <columnId>`; a **merge label**
is the zero-setup alternative. Merge runs while the worktree is still alive —
we **never** auto-`complete` (that's a blocking human approval that destroys the
worktree). "Done" = the merge commit in git (constraint #7), not the column.

Merge-policy dispatch at the human gate:
- `open_pr` → `OpenPr` (gh), then park (human merges on GitHub / it sits in `review-by-colleague`).
- `merge_when_green` → require last checks green, `Merge`.
- `fix_until_green_and_merge` → the in-progress/grader fix-loop already enforced green+pass; `Merge`.

Human edits are authoritative inputs (level-triggered, re-derived each tick):
dragging a card out of `user-questions` back to `in-progress` = "blocker resolved,
resume" → reset `consecutiveFailures` (**not** `totalAttempts`). Dragging to
`cancelled`/`completed` (UI-only) ⇒ observe as terminal, stop reconciling.

---

## 7. Guardrails (`src/domain/guardrails.ts`) — pure predicates

`shouldGiveUp(journal, policy, now): { stop: boolean; reason?: string }`, evaluated before any fix re-prompt:

- **Consecutive-failure cap:** `consecutiveFailures >= maxConsecutiveFailures`.
- **Absolute iteration cap:** `attempts.length >= maxTotalAttempts`.
- **No-progress (failure signature):** last `K=2` red attempts share the same `failureSignature` → flailing.
- **Oscillation (diff hash):** a `diffHash` repeats across attempts → cycling between states.
- **Stall:** `now - lastHeartbeatAt > stallMs` with no new output. Heartbeat source order (DISCOVERY §Q3): `getTerminalPreview` RPC delta → worktree file mtime → `task.updatedAt`/`movedAt` → raw `capture-pane` (timeout-guarded only; it hangs on control-mode sessions).
- **Per-card budget:** `totalTokens > tokenBudget`.

Separately, fleet-level (`src/domain/fleet.ts`):
- **Concurrency cap** (default 20): only promote `todo → in_progress` up to N live cards.
- **Daily spend ceiling:** when exceeded, stop *promoting* new cards (drain in-flight).
- **Circuit breaker:** if recent failure rate across cards > 50%, pause promotions and emit a `breaker_open` event.

On give-up: `MoveLane → user_questions`, `addNote` the diagnostic (`attempt n/N, signature, spend`), **leave the worktree intact**. Mirror live counters to the card via `addNote` each cycle so the human sees progress on the board.

---

## 8. The independent grader (`src/domain/grader.ts` + runtime)

**Default launch mechanism = reuse dev-3.0's `review-by-ai` column agent**
(DISCOVERY §Q5), not a hand-rolled grader runtime. Moving a card to
`review-by-ai` makes dev-3.0 spawn a *fresh* agent (new pane, `skipSystemPrompt`,
**no producer conversation inherited**) running `builtinColumnAgents[
"review-by-ai"]`. We must **override that config per repo** to:
1. **a different model** than the producer (e.g. producer `claude-default-opus48`,
   grader `gemini-default` / `codex-default`) — never leave it unset (the default
   is a same-family *fixer* that edits & commits);
2. **our adversarial rubric prompt** (see §11) that re-runs the checks itself,
   diffs `origin/<base>`, writes `.dev3/review.json`, and is told **not to edit**.

Rules that still hold:
- Spawned only **after** mechanical checks pass (never grade non-compiling output).
- `policy.grader` MUST differ from `policy.producer` in agent or config; assert at
  config-load and fail fast. **Warn** when only `config` differs but the resolved
  *model* is identical (DISCOVERY §Q4 — the registry exposes the model per config).
- Input = acceptance criteria (or full description) + `git diff origin/<base>` +
  check output. No producer conversation/scrollback.
- Read-only is **prompt-level**, not enforced (plan-mode would block writing
  `review.json`). The real guarantee is constraint #8: **we re-run checks and git
  is truth**, so a rogue edit can't fake a pass. Optional hardening: grade in a
  throwaway worktree checked out at branch HEAD.
- Output: `.dev3/review.json` with a per-criterion verdict. **The verdict, not the
  lane, drives routing** (§6) — the reconciler reads it even after dev-3.0's
  on-exit hook nudges the card to `review-by-user`. `changes_requested` routes
  findings back to the **producer's** session (producer keeps context for the fix).

`RuntimePort.launchGrader(card)` is the seam: the default adapter performs the
`review-by-ai` move (with overridden config); an **out-of-band** adapter (fresh
headless invocation, full routing control, hard input isolation) is a drop-in
alternative the domain never sees — `decide()` only ever emits `LaunchGrader`.

---

## 9. Persistence, idempotency, recovery (`src/adapters/fs/*`)

- **Journal:** one JSON file per card under `${stateDir}/journal/<cardId>.json`. Atomic writes (write tmp, `rename`).
- **Event log:** append-only NDJSON at `${stateDir}/events.ndjson`. Every intent/done pair, every lane move, every guardrail trip. This is the replayable spine; the journal is a derived projection you may rebuild from it.
- **Write-ahead for effects:** before `Merge`/`OpenPr`, set `journal.pending[actionId] = {kind, startedAt}` and append intent; after success, clear and append done. On startup, for each `pending` entry, **verify reality** (`git.isMerged`, PR exists?) and reconcile — never blind-retry.
- **Crash test is a first-class requirement** (see §14): kill between intent and done, restart, assert exactly-once.

---

## 10. Agent prompt contracts (`src/prompts/*.md`, schemas in `dto.ts`)

Producer launch prompt appends a fixed protocol:
- Maintain `.dev3/progress.md` (tried / failed-because / next / invariants) and re-read it on resume.
- On finish, write `.dev3/result.json` then stop:

```jsonc
// .dev3/result.json
{ "status": "done" | "blocked",
  "summary": "string",
  "blockedQuestion": "string|null",
  "claimedTestsPass": true }   // never trusted; we re-run
```

Grader prompt (separate model, read-only, adversarial):
```jsonc
// .dev3/review.json
{ "verdict": "pass" | "changes_requested",
  "criteria": [{ "criterion": "string", "met": true, "note": "string" }],
  "blocking": ["string"],     // empty iff verdict == pass
  "ranChecks": true }
```

Failure signature = stable hash of the sorted failing-test ids (fallback: normalized first error line). Diff hash = hash of `git diff base...branch`.

---

## 11. Configuration

- **Per-repo policy file** `CRABBOX.md` (or `.dev3-loop.yaml`) at repo root, YAML frontmatter: `merge.default_policy`, `cap`, `stall_ms`, `producer`, `grader`, `checks`. `ConfigPort.policyFor(card)` evaluates repo defaults then per-card overrides (from card labels/description).
- **Env / `config.json`:** `stateDir`, `dev3StorePath` (DISCOVERY §18), `dev3Bin` (path to `dev3`), `tickIntervalMs`, `concurrencyCap`, `dailySpendCeiling`, `defaultPolicy`.
- Validate config at boot with a small schema; fail fast with a readable error (esp. producer==grader).

---

## 12. Project layout

```
dev3-loop/
├── src/
│   ├── domain/        # PURE: types, reconcile, guardrails, grader, fleet, hashing
│   ├── ports/         # interfaces + dto.ts (no impls)
│   ├── adapters/
│   │   ├── dev3/      # Dev3CliBoard (CLI mutate) + Dev3JsonReader (read store)
│   │   ├── tmux/      # TmuxRuntime (spawn, capture-pane, send-keys)
│   │   ├── git/       # GitCli (diff, checks, merge, gh pr)
│   │   └── fs/        # FsJournal, NdjsonEventLog, SystemClock, FileConfig
│   ├── app/           # composition root: wires ports→adapters, runs the loop
│   └── cli.ts         # `dev3-loop run | dry-run | replay | preflight`
├── tests/
│   ├── unit/          # decide(), guardrails, grader routing — Fake* ports
│   ├── recovery/      # crash/idempotency/replay
│   └── integration/   # real git in tmpdir; real tmux (tagged, skip if absent)
├── prompts/           # producer/grader prompt templates
├── docs/              # ARCHITECTURE.md, POLICY.md, OPERATIONS.md
├── AGENTS.md          # conventions for agents working on THIS repo
├── README.md
├── package.json  tsconfig.json  vitest.config.ts
```

---

## 13. Testing strategy (mirror dev-3.0: `vitest` + `tsc --noEmit`)

Core principle: **the domain is pure, so it's tested with zero I/O.** Adapters are thin and tested against real git (tmpdir) and real tmux (tagged).

Mandatory unit tests (`tests/unit`):
1. `decide()` returns the correct `Action` for **every** row of the §6 transition table (table-driven).
2. Producer self-report is ignored: `result.json.claimedTestsPass=true` but `runChecks` red ⇒ red path.
3. Grader independence assertion: config with producer==grader ⇒ boot error.
4. Grader only launches after green; non-compiling output never reaches `ai_review`.
5. Guardrails: each of the six predicates trips on its own fixture and not otherwise; consecutive-failure resets on green; no-progress trips on repeated signature; oscillation trips on repeated diff hash.
6. Fleet: concurrency cap blocks promotion; spend ceiling drains; breaker opens >50% fail rate.
7. Human override: drag from `user_questions → in_progress` resets consecutiveFailures, not totalAttempts; drag to `cancelled` is terminal.
8. Merge-policy dispatch: each of the three policies yields the correct gate action.

Recovery tests (`tests/recovery`):
9. Kill between `Merge` intent and done ⇒ restart ⇒ `isMerged` true ⇒ **no second merge** (exactly-once).
10. Journal rebuildable from `events.ndjson` (replay equals live projection).
11. Lost `fs.watch` event ⇒ next periodic reconcile still converges (level-triggered correctness).

Integration tests (`tests/integration`, tagged, skip when binary missing):
12. `GitCli` against a throwaway repo: diff, checks (passing + failing fixture), merge, isMerged.
13. `TmuxRuntime`: create session, send-keys, capture-pane round-trip, isAlive after kill.
14. `Dev3JsonReader`: parse a committed sample store fixture into `Card[]`.

CI: `bun install && tsc --noEmit && vitest run` (unit + recovery always; integration when tmux/git present). Provide fixtures under `tests/fixtures/` (sample dev-3.0 store JSON, capture-pane transcripts, result/review JSON, failing-test output).

---

## 14. Documentation deliverables (part of "done")

- **README.md** — what it is, quickstart, how to point it at a dev-3.0 install, the two open questions (§18) called out explicitly, and a "trust ladder" note (start in `dry-run`, then `open_pr`, then `merge_when_green`, then `fix_until_green_and_merge`).
- **docs/ARCHITECTURE.md** — ports/adapters diagram, the reconcile loop, state ownership table (board=stage, git=done, journal=loop-meta), why level-triggered + write-ahead.
- **docs/POLICY.md** — `CRABBOX.md`/policy file format, every knob, defaults, examples.
- **docs/OPERATIONS.md** — running, `preflight`, `replay`, reading the event log, what each guardrail trip looks like on the board, recovery after a crash.
- **AGENTS.md** — conventions for agents editing this repo (mirrors dev-3.0's own AGENTS.md ethos): pure-domain rule, no I/O in `domain/`, test-first, atomic writes.
- TSDoc on every port method and every `Action` variant.

---

## 15. Build order / milestones (each must be green before the next)

- **M0 — scaffold.** Bun project, strict tsconfig, vitest, `tsc --noEmit`, CI, empty module tree, `cli.ts` with `--help`. Test: trivial smoke.
- **M1 — pure core + fakes.** Domain types, `decide()`, Fake ports, composition root running a tick against fakes. Tests 1–4, 7, 8. **No real I/O anywhere.**
- **M2 — persistence + recovery.** FsJournal (atomic), NdjsonEventLog, write-ahead, replay. Tests 9–11.
- **M3 — guardrails + fleet.** All predicates + caps + breaker. Tests 5, 6.
- **M4 — real adapters behind ports.** `GitCli`, `TmuxRuntime`, `Dev3JsonReader`, `Dev3CliBoard`. Mark CLI/store assumptions `// DISCOVERY`. Tests 12–14.
- **M5 — grader stage.** Separate-model launch, review.json, findings routing. Extend unit tests.
- **M6 — merge-policy execution.** OpenPr/Merge, merge-before-teardown ordering, exactly-once. Recovery test 9 against real git.
- **M7 — docs + dry-run E2E.** `dry-run` that logs intended actions without mutating. Fill all docs.

---

## 16. Definition of done

- `tsc --noEmit` clean; `vitest run` green (unit + recovery); integration green where tmux/git available.
- Core has **zero** adapter imports; `domain/` does no I/O (enforce with a test that greps imports, or an eslint boundary rule).
- `dev3-loop dry-run` against a sample store prints a correct action plan for each lane with no side effects.
- All four guardrail families demonstrably trip in tests and surface a board note + `user_questions` move.
- Every effectful action is idempotent and write-ahead logged; the exactly-once merge recovery test passes.
- README + ARCHITECTURE + POLICY + OPERATIONS + AGENTS present; the two open questions are clearly flagged.

---

## 17. Open questions / discovery (do NOT guess — stub + document)

1. **`dev3` CLI surface.** Need real subcommands for *list cards*, *move card to lane/column*, *add note*. Until provided, implement `Dev3CliBoard` against assumed commands (`dev3 task list --json`, `dev3 task move <id> <col>`, `dev3 note add <id> <text>`) with each marked `// DISCOVERY` and centralized in one module. Provide `FakeBoard` for all tests so nothing blocks. Action item for the human: paste `dev3 task --help` (and `dev3 --help`).
2. **JSON store path + schema.** Need the on-disk location (likely under `~/.dev3.0/`) and the card record shape, to implement `Dev3JsonReader`. Make the path a config value (`dev3StorePath`) defaulting to a best guess; ship a `preflight` command that locates and validates the store and prints the detected schema. Commit a sample store as a test fixture once known.
3. **Completion signal.** Default to the `.dev3/result.json` / `.dev3/review.json` convention written by the agents (we control the prompts). Optionally add a tmux `alert-bell` hook (`tmux set-hook -t <session> alert-bell 'run-shell "..."'`) as a faster wake; the file remains authoritative.
4. **Per-repo checks command.** Comes from the policy file (`checks:`). Confirm the canonical lint/test commands per target repo.

---

## 18. Discovery findings — ANSWERED

All four §17 open questions are answered against the real dev-3.0 install
(`~/.dev3.0`, `dev3` CLI). Full evidence + schemas in **`DISCOVERY.md`**. The
six design deltas that must be folded in **before M1**:

1. **Lanes = real statuses:** `todo · in-progress · review-by-ai · review-by-user
   · user-questions`. `completed`/`cancelled` are UI-only, **destroy the
   worktree**, and are **not** CLI-settable — observe-only terminal states.
2. **Don't double-review (biggest change):** dev-3.0 **already runs its own
   review agent** when a card enters `review-by-ai`, and ships `mergeTask`/
   `createPullRequest` RPCs and a `review-by-colleague` ("PR Review") lane. So
   dev3-loop must position as the *rigorous autonomous reconciler* (independent
   different-model read-only grader, checks-as-truth, guardrails, write-ahead
   exactly-once, level-triggered) and must **disable/​bypass
   `builtinColumnAgents["review-by-ai"]`** (or grade out-of-band) so the two
   reviewers don't collide. The `ready_to_merge` merge-trigger **is viable** — a
   custom column with no `agentConfig`, moved into via `task move --status
   <columnId>` (custom-column moves ARE CLI-reachable; only *creating* a column is
   RPC/GUI). Use `--if-status`/`--if-status-not` (server-enforced compare-and-set)
   for race-free idempotent moves. Never auto-`complete` (blocking approval that
   destroys the worktree).
3. **Store:** read-only JSON is **split** — `~/.dev3.0/projects.json` +
   `~/.dev3.0/data/<slug>/tasks.json` (slug = project path, `/`→`-`, no leading
   `/`). `config.dev3StorePath` defaults to `~/.dev3.0`. **`tasks list --json`
   prints a table, not JSON** — read the store directly; mutate only via CLI.
4. **git:** dev-3.0 does worktree+branch only; merge/PR is entirely ours. Branch =
   `dev3/task-<taskId8>`; worktree = `task.worktreePath`; sibling `logs/`+`diffs/`
   dirs are candidate heartbeat/diff sources.
5. **tmux:** socket `~/.dev3.0/sockets/<pid>.sock`, sessions `dev3-<taskId8>`.
   `capture-pane`/`list-windows` **hang** on attached control-mode sessions →
   timeout-guard all pane reads; prefer file signals for correctness.
6. **AgentSpec = {agentId, configId}** with a rich registry (claude/codex/gemini/
   cursor/opencode). Default pairing: producer `builtin-claude`/
   `claude-default-opus48`, grader a **different model** (e.g.
   `builtin-gemini`/`gemini-default`). acceptanceCriteria isn't structured — parse
   from `description` or pass the whole description to the grader.

---

## 19. Task breakdown — first part (M0 + M1), managed in dev-3.0

Each task = one small, focused, self-reviewable commit. `tsc --noEmit` clean +
`vitest run` green is the bar for every task. Checks command for this repo:
`bun install && tsc --noEmit && vitest run`. Strict dependency order:

**M0 — scaffold**
- **T1 Scaffold Bun + TS project.** `package.json` (vitest dev dep only),
  strict `tsconfig.json`, `vitest.config.ts`, `.gitignore`, empty `src/{domain,
  ports,adapters,app}` + `tests/` tree, one smoke test. Gate: install + tsc + 1
  passing test.
- **T2 CLI skeleton.** `src/cli.ts` parsing `run | dry-run | replay | preflight` +
  `--help`/`--version`; unknown cmd → non-zero. Test: arg parse + help. (dep: T1)
- **T3 CI workflow.** `.github/workflows/ci.yml`: bun install → tsc --noEmit →
  vitest run. (dep: T1)

**M1 — pure domain core + fakes** (no real I/O anywhere)
- **T4 Domain types.** `src/domain/types.ts`: `Lane`, `CustomColumnId`,
  `MergePolicy`, `AgentSpec`, `CardPolicy`, `Card`, `AttemptRecord`,
  `CardJournal`, `Action` (TSDoc each variant). Gate: tsc + type-level test. (dep: T1)
- **T5 Ports + DTOs.** `src/ports/*.ts` + `dto.ts`: all 7 ports, `CheckResult`/
  `MergeResult`/`PrResult`/`ProducerResult`/`GraderReview`/`LoopEvent`. TSDoc.
  No impls. (dep: T4)
- **T6 Fake adapters.** in-memory `FakeBoard`/`FakeRuntime`/`FakeGit`/
  `FakeJournal`/`FakeEventLog`/`FixedClock`/`FakeConfig` for tests. (dep: T5)
- **T7 `decide()` state machine.** `src/domain/reconcile.ts`: pure §6 table incl.
  verdict-driven routing + custom-column key + `MoveLane.expect`; merge-policy
  dispatch. Excludes guardrail caps (M3) — stub the predicate as `allow`. (dep: T4,T5)
- **T8 `decide()` table tests.** table-driven every §6 row; producer self-report
  ignored (red wins); grader only after green; merge-policy dispatch; human
  override resets `consecutiveFailures` not `totalAttempts` (tests 1,2,4,7,8). (dep: T6,T7)
- **T9 Config boot + validation.** `src/app/config.ts` + `ConfigPort` fake: load
  config + per-repo policy, defaults, **fail-fast on producer==grader** + warn on
  same-model (test 3). (dep: T5)
- **T10 Composition root + tick loop.** `src/app/loop.ts`: wire ports→fakes,
  `tick()` = intent→execute→done→persist, level-triggered runner. Test: N ticks
  drive a fake card `todo → … → review-by-user` against fakes. (dep: T6,T7,T9)

Later milestones (M2 persistence/recovery, M3 guardrails/fleet, M4 real adapters,
M5 grader, M6 merge, M7 docs/dry-run) get their own task cards once M1 is green —
created just-in-time to avoid a stale backlog.

**Bootstrap prerequisite (not a dev-3.0 task — must be done first):** the repo
has no commits and `main` doesn't exist yet, but the project's base branch is
`main` and every dev-3.0 worktree branches from it. So an initial commit on
`main` containing `PLAN.md` + `DISCOVERY.md` (so worktree agents can read them) is
required before any task can run.
