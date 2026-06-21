# DISCOVERY — answers to the §17 open questions

Gathered against the **real** dev-3.0 install on this machine (`~/.dev3.0`,
`dev3` = `~/.dev3.0/bin/dev3`) on 2026-06-20. This supersedes the *guesses* in
`PLAN.md §17`. Where reality contradicts the plan, the impact is called out under
**⚠ PLAN IMPACT**.

---

## Q1 — `dev3` CLI surface ✅ ANSWERED (`dev3 --help`)

The CLI is real and AI-facing. It **auto-detects project + task from the worktree
CWD**, so commands run from inside a task worktree need no ids; from outside you
must pass `--project <id>` and/or `--task <id>`.

Relevant verbs for the reconciler:

| Need | Real command |
|---|---|
| list tasks | `dev3 tasks list [--status <s>] [--label <id>] [--limit] [--offset]` (also `--project <id>`) |
| show one task | `dev3 task show [--task <id>] [--notes] [--history]` |
| **move lane** | `dev3 task move [--task <id>] --status <status>` |
| add note | `dev3 note add "..." [--task <id>] [--source user]` |
| list/show/delete notes | `dev3 note list / show <id> / delete <id> [--task <id>]` |
| set overview (1 paragraph, shows on card) | `dev3 overview set "..." [--task <id>]` |
| labels | `dev3 label list / create / delete / set <id>... [--task <id>]` |
| create task | `dev3 task create --title "..." [--description "..."]` |
| effective project settings | `dev3 config show` / `dev3 config export` → writes `.dev3/config.json` |
| install agent hooks into a worktree | `dev3 install-hooks` |

`@file` syntax: any arg starting with `@` is read from a file (`@plan.md`); `@@` = literal `@`.
Useful for `note add @diagnostic.md` / long fix prompts.

### Statuses (the real Lane enum)

```
todo · in-progress · user-questions · review-by-ai · review-by-user
```

`completed` and `cancelled` are **UI-only** — and the help explicitly says they
**destroy the worktree**. `dev3 task move --status` only accepts the five live
statuses above; **there is no CLI verb to mark a task completed/cancelled**.

> **⚠ PLAN IMPACT (lane names):** the `Lane` type in PLAN §4 must be remapped to
> the real status strings. Mapping:
> | PLAN Lane | real status |
> |---|---|
> | `in_progress` | `in-progress` |
> | `ai_review` | `review-by-ai` |
> | `user_review` | `review-by-user` |
> | `user_questions` | `user-questions` |
> | `done` | *(UI-only `completed`, not CLI-settable)* |
> | `cancelled` | *(UI-only `cancelled`, not CLI-settable)* |
> Keep the domain enum = the five CLI-settable statuses plus terminal markers we
> only ever *observe* (never write).

> **✅ CORRECTION — custom-column move IS CLI-reachable (Q2 answered from source):**
> My earlier "not reachable" claim was wrong. From `src/cli/commands/task.ts`
> `moveTask()`: any non-built-in `--status` value is passed straight through to
> the server `task.move` RPC, which validates it as a **custom column ID** —
> comment: *"Non-built-in values may be custom column IDs — let the server
> validate."* So `dev3 task move --task <id> --status <customColumnId>` works.
> The PLAN's `ready_to_merge` custom column **is viable as the merge trigger.**
> Details + caveats in the new **§Q2-bis (custom columns & states)** below.

### Reads: why `tasks list --json` doesn't work (root cause, from source)

`src/cli/commands/tasks.ts` has **no `--json` branch** — the `list` handler
*always* calls `printTable(...)`. The flag is accepted by the generic arg parser
but never read here (only `conversations search` implements `--json`). The data
is fully structured under the hood: the CLI does
`sendRequest(socketPath, "tasks.list", {projectId,…})` → `Task[]`, sorts by
`seq` desc, and formats a table client-side.

So three ways to read tasks, in order of preference:
1. **Read `data/<slug>/tasks.json` from disk** (read-only) — simplest, matches
   PLAN constraint #2, no live server needed. **Recommended for `listCards`.**
2. **Speak the socket RPC** `tasks.list` to `~/.dev3.0/sockets/<pid>.sock`
   yourself — same data the CLI gets, no table parsing, but couples us to the
   server being up and the RPC framing.
3. Don't parse the table output. (And don't wait for upstream to add `--json`.)

Use the `dev3` CLI **only for mutations** (`task move`, `note add`,
`overview set`, `label set`).

---

## Q2 — JSON store path + schema ✅ ANSWERED

**Not a single file.** The store is split:

```
~/.dev3.0/
├── projects.json                 # array of Project records (registry)
├── settings.json                 # global: defaultAgentId/ConfigId, agentBinaryPaths, …
├── projects-YYYY-MM-DD.json.bak  # dated backups of projects.json
├── tip-state.json                # UI tips state (ignore)
├── bin/{dev3,dev3-server}
├── sockets/<pid>.sock            # tmux socket (see Q3)
├── logs/<year>/…                 # server logs
├── data/<project-slug>/tasks.json   # ← THE TASKS, one file per project
└── worktrees/<project-slug>/<taskId8>/{worktree,logs,diffs}
```

**`project-slug`** = the project's absolute path with `/` → `-` and the leading
`/` dropped. e.g. `/Users/gabik/git/dev-center-platform` →
`Users-gabik-git-dev-center-platform`. (Used for both `data/` and `worktrees/`.)

> **⚠ PLAN IMPACT:** `config.dev3StorePath` should default to `~/.dev3.0` (the
> root), and `Dev3JsonReader` must (1) read `projects.json`, (2) for each project
> compute the slug and read `data/<slug>/tasks.json`, (3) join them. There is no
> single `dev3StorePath` JSON file.

### Project record (`projects.json`)

```jsonc
{
  "id": "244dfd63-…",            // uuid
  "name": "dev-center-platform",
  "path": "/Users/gabik/git/dev-center-platform",  // → slug
  "setupScript": "", "setupScriptLaunchMode": "parallel",
  "devScript": "", "cleanupScript": "",
  "defaultBaseBranch": "master",
  "clonePaths": [],              // e.g. ["venv"] — dirs symlinked/copied into worktree
  "createdAt": "2026-…Z",
  "labels": [ { "id": "uuid", "name": "refactor", "color": "#ef4444" } ],
  "customColumns": []            // present but empty everywhere here
}
```

### Task record (`data/<slug>/tasks.json` — array)

```jsonc
{
  "id": "8daefe75-0c57-…",        // uuid; 8-char prefix is the CLI/worktree handle
  "seq": 2,                       // per-project sequence number
  "projectId": "244dfd63-…",
  "title": "…",                   // raw title (often the full prompt's first line)
  "description": "…",             // the full task prompt / acceptance criteria (markdown)
  "status": "review-by-user",     // one of the 5 statuses (+ completed/cancelled if archived)
  "baseBranch": "master",
  "worktreePath": "/Users/…/worktrees/<slug>/8daefe75/worktree",  // null until started
  "branchName": "dev3/task-8daefe75",                              // null until started
  "groupId": "uuid", "variantIndex": 1,    // task "variants" (N parallel attempts of one prompt)
  "agentId": "builtin-claude",             // ← producer AgentSpec.agent
  "configId": "claude-default-opus48",     // ← producer AgentSpec.config
  "createdAt": "…Z", "updatedAt": "…Z", "movedAt": "…Z",
  "tmuxSocket": "dev3",                     // logical socket name (see Q3 caveat)
  "labelIds": ["uuid", …],
  "preparing": false, "preparingStage": null, "preparingProgress": null, "preparingStartedAt": null,
  "history": [ { "at": "…Z", "title": "…", "overview": null, "changed": "created|title|overview" } ],
  "notes": [],                              // note bodies; `note add` appends here
  "customTitle": "…", "titleEditedByUser": false,
  "customColumnId": null,
  "overview": "one-paragraph status shown on the card",  // `overview set` writes this
  "userOverview": null,
  "sessionState": { "panes": [ { "agentCmd": "claude", "sessionId": "uuid",
                                 "agentId": "builtin-claude", "configId": "claude-default-opus48" } ] },
  "columnOrder": 0
}
```

Mapping to PLAN §4 `Card`: `id`←id, `repo`←project.name (or derive owner/name
from git remote), `baseBranch`←baseBranch, `branch`←branchName, `worktreePath`←
worktreePath, `lane`←status, `prompt`←description, `acceptanceCriteria`← parse
from description (no structured field — see note), `policy.producer`←
{agentId, configId}.

> **Note (acceptanceCriteria):** there is **no structured acceptance-criteria
> field** — it's embedded in `description` markdown. Options: (a) parse a
> conventional `## Acceptance criteria` / `## Tests` section, or (b) feed the
> whole `description` to the grader as criteria. Decide in M5; (b) is safe default.

**Sample fixture:** commit a sanitized copy of one `projects.json` entry + its
`data/<slug>/tasks.json` under `tests/fixtures/store/` (PLAN test #14).

---

## Q2-bis — Custom columns & states ✅ ANSWERED (from source)

Two different things; don't conflate them:

**Built-in statuses are a fixed enum** — `src/shared/types.ts` `TaskStatus`:
`todo · in-progress · user-questions · review-by-ai · review-by-user ·
review-by-colleague · completed · cancelled`. **You cannot add a new status**
without patching dev-3.0. (I missed `review-by-colleague` = "PR Review" the first
pass — see overlap §below.) You *can* rename any built-in column's display label
via `project.customStatusLabels` (RPC/GUI), but that's cosmetic.

**Custom columns CAN be added** (`Project.customColumns: CustomColumn[]`,
`Task.customColumnId`) — these are the way to add board states:
- **Create / update / delete:** RPC only (`createCustomColumn`,
  `updateCustomColumn`, `deleteCustomColumn`) or the GUI. **No `dev3` CLI verb**
  to create one. So a one-time setup step (GUI or a socket call) is needed.
- **Move a task into one: via CLI** — `dev3 task move --task <id> --status
  <customColumnId>` (server validates). Find the id via `dev3 current` (it prints
  the project's custom columns) or from `projects.json → customColumns[].id`.
- **A custom column can carry its own agent** (`CustomColumn.agentConfig:
  {agentId, configId, prompt}`): moving a task into it **auto-launches that agent**
  in the task's tmux pane (`triggerColumnAgentIfNeeded` → `launchColumnAgent`).
  Relevant if we want a column to *be* an agent stage — or a hazard if we want a
  column to be an inert parking/merge-trigger lane (set no `agentConfig`).

**Conditional / atomic moves (big win for the reconciler):** `task move` accepts
`--if-status <csv>` and `--if-status-not <csv>` (see `isStatusGuardBlocked`). The
guard is enforced **inside the server's data lock**, so it's true compare-and-set
— exactly the optimistic-concurrency primitive the reconciler wants to make lane
moves idempotent and race-free against the human dragging cards.

> **⚠ PLAN IMPACT (merge trigger, revised):** a custom column **with no
> `agentConfig`** (e.g. `ready_to_merge`) is the cleanest merge trigger: human (or
> a policy) moves the card in, the loop detects `customColumnId == <ready>` and
> merges with an `--if-status <ready>` guard, then notes the result. Worktree is
> still alive (only `completed`/`cancelled` destroy it). One-time: create the
> column via GUI/RPC. A **label** remains a fine no-setup alternative.

> **⚠ PLAN IMPACT (`completed` is reachable but blocking):** `dev3 task move
> --status completed` is NOT forbidden — it calls `task.requestCompletion`, which
> pops a **blocking approval dialog in the app** (10-min timeout) and only then
> moves + destroys the worktree. `cancelled` is fully forbidden via CLI. So the
> loop should never auto-`complete`; it parks and lets the human approve.

---

## Q3 — Completion signal & runtime (tmux) ✅ MOSTLY ANSWERED

### tmux
- **Socket:** `~/.dev3.0/sockets/<pid>.sock` (one live socket, named by server pid;
  was `44949.sock` at probe time — discover by globbing, don't hardcode).
  `tmux -L dev3` also resolves to it.
- **Session per task:** `dev3-<taskId8>` (e.g. `dev3-8daefe75`), plus a
  `dev3-home` session. Confirmed live: `tmux -S <sock> ls` lists all 7 sessions.
- `task.tmuxSocket` field = the string `"dev3"` (logical name, not the socket path).

> **⚠ DISCOVERY / M4 RISK (capture-pane hangs):** `tmux -S <sock> ls` works, but
> `list-windows -t <session>` and `capture-pane -p -t <session>` **hang
> (timeout)** against these sessions — at least the one currently *attached*
> (`dev3-1f9bdff9 … (attached)`). Likely the dev-3.0 GUI holds a **control-mode
> (`-CC`) client**, which blocks/serializes other clients' commands. M4 must
> resolve how to read panes safely: try targeting an explicit pane
> (`-t dev3-<id>:0.0`), `capture-pane -p -S -` with a short timeout wrapper, or a
> read-only client. **Mitigation:** prefer the file-based signals below over
> scraping the pane for correctness; use capture-pane only as a heartbeat/last
> resort, always behind a timeout so the reconcile tick can't block.

### "Better heartbeat" — what I meant (clarification)

PLAN §7 defines the stall heartbeat as *"capture-pane byte delta or result-file
mtime"* — i.e. scrape the tmux pane each tick and diff the bytes to tell whether
the agent is still producing output. The problem (above): raw `capture-pane`
**hangs** on the control-mode sessions, and a hang inside `tick()` stalls the
whole reconcile loop. "Better heartbeat" = a liveness signal that is cheaper,
can't block the tick, and doesn't depend on the fragile direct-tmux read.
Concretely, prefer (in order):
- **`getTerminalPreview` RPC** (`{taskId} → string|null`) — dev-3.0 reads the
  pane *for us* over the socket and returns the text. Server-mediated, so it
  doesn't fight the control-mode client the way our own `capture-pane` does. This
  is the single best replacement for byte-delta heartbeat **and** for reading the
  producer's scrollback. (Confirm it doesn't hang the same way — M4.)
- **Worktree file mtimes** — newest mtime under `worktree/` (or `git -C … status`
  churn) advancing = agent is doing work. Zero tmux dependency.
- **Store fields** — `task.updatedAt` / `movedAt` / `overview` changing between
  ticks; coarse but free (we already read the store).
- Raw `capture-pane -p -S -` only as a **timeout-guarded** last resort.

### Completion / heartbeat signals (in priority order)
1. **dev-3.0's own per-task dirs** (free, no tmux): each task has
   `worktrees/<slug>/<taskId8>/{logs,diffs}` alongside `worktree/`. These existed
   (empty for an idle task) — dev-3.0 maintains them. **Investigate in M4 whether
   `logs/` gets the agent transcript and `diffs/` the live diff** — if so they are
   a far more reliable heartbeat (mtime delta) and diff source than capture-pane,
   and `diffs/` may even replace `git diff` for the diff-hash.
2. **Our `.dev3/result.json` / `.dev3/review.json` convention** (PLAN §10) — we
   control the producer/grader prompts, so this stays the **authoritative** done
   signal. The worktree uses `.dev3/` already (`dev3 config export` writes
   `.dev3/config.json`; `dev3 install-hooks` installs there) — our `result.json`/
   `review.json` filenames don't collide. Confirm `.dev3/` isn't `.gitignore`d in
   a way that matters (it only needs to exist on disk in the worktree, not be
   committed).
3. **`status` transitions in `tasks.json`** — coarse, but a card leaving
   `in-progress` is itself an event we level-trigger on.
4. `settings.json` has `playSoundOnTaskComplete: true` (terminal-bell style
   signal exists) — optional latency optimization only; the file remains truth.

### git: dev-3.0 owns worktree+branch; merge/PR exists but only via RPC
- Branch name is deterministic: **`dev3/task-<taskId8>`**.
- Worktree is a real git worktree (`.git` file points to the parent repo;
  `git -C <worktree> branch --show-current` → `dev3/task-<id8>`).
- dev-3.0 **does** implement merge/PR — `mergeTask`, `pushTask`, `rebaseTask`,
  `createPullRequest`, `openPullRequest` RPCs (see overlap §). But these are
  **socket/GUI only, not in the `dev3` CLI**. So PLAN's plan to **drive git
  ourselves via `GitPort`** is still the recommended path for write-ahead /
  exactly-once control; calling dev-3.0's `mergeTask` RPC is the alternative.

---

## Q4 — Producer/grader agent+config registry ✅ ANSWERED (bonus)

`AgentSpec = { agent: <agentId>, config: <configId> }`. Real ids (from
`dev3-server`):

**Agents:** `builtin-claude` (default), `builtin-codex`, `builtin-gemini`,
`builtin-cursor` (+ opencode configs imply an opencode agent).

**Configs** (selected — each is `{id, name, model, permissionMode?, additionalArgs?}`):
- Claude: `claude-default` (Fable 5), `claude-default-opus48` (Opus 4.8, **the
  installed default**), `claude-default-opus47`, `claude-default-sonnet`, plus
  `…-approvals/-auto/-bypass/-dontask/-plan` variants per model.
- Codex: `codex-default`.
- Gemini: `gemini-default` (3.1 Pro), `gemini-flash*`, `gemini-yolo`, `gemini-plan`.
- Cursor: `cursor-default` (Opus 4.6), `cursor-gpt` (GPT-5.3 Codex), `cursor-gemini`.
- OpenCode: `opencode-default` (Sisyphus/Opus 4.6), `opencode-hephaestus`,
  `opencode-prometheus`, `opencode-atlas`, `opencode-gpt54-mini`, `opencode-haiku`, …

Installed default (`settings.json`): `defaultAgentId: builtin-claude`,
`defaultConfigId: claude-default-opus48`, `agentBinaryPaths."builtin-claude":
/Users/gabik/.local/bin/claude`.

> **PLAN IMPACT (grader config, §8):** there's lots of cross-model choice if you
> *want* a different-model grader. Recommended (not enforced) default pairing:
> **producer `builtin-claude`/`claude-default-opus48`**, grader a different model
> — e.g. `builtin-gemini`/`gemini-default` or `builtin-codex`/`codex-default`.
> But the producer and grader **may also share the same model/config** (e.g. Opus
> for both): grader independence comes from the separate `review-by-ai` launch +
> read-only rubric prompt + re-running checks, not from a distinct `(agent,
> config)`. So there is **no** boot-time producer≠grader assertion — config just
> validates schema + fills defaults.

---

## ⭐ Overlap analysis — dev-3.0 already implements part of the plan

Reading the source revealed dev-3.0 already ships machinery PLAN.md set out to
build. This **sharpens dev3-loop's value proposition** and changes a few build
decisions. The overlaps:

| PLAN feature | dev-3.0 already has | Gap dev3-loop still fills |
|---|---|---|
| Independent AI grader stage | **`review-by-ai` column auto-runs a review agent.** Moving a task to `review-by-ai` launches `builtinColumnAgents["review-by-ai"]` (default `builtin-claude`/`claude-bypass-sonnet`, `DEFAULT_REVIEW_PROMPT`) in the pane; on exit it self-moves `review-by-ai → review-by-user` via `dev3 task move … --if-status review-by-ai`. | dev-3.0's reviewer is **not independent in the rigorous sense**: it runs *in a pane, can commit fixes itself*, defaults to the **same agent family** (sonnet), has **no structured `review.json`**, and doesn't *re-run mechanical checks as source of truth*. dev3-loop's grader = **read-only**, structured per-criterion verdict, checks re-run (optionally a different model). To avoid double-grading, either disable `builtinColumnAgents["review-by-ai"]` in project config, or run our grader **out-of-band** (fresh invocation / custom column) and treat `review-by-ai` as just a lane. |
| Merge / PR | **RPCs exist:** `mergeTask`, `pushTask`, `rebaseTask`, `createPullRequest {autoMerge?}`, `openPullRequest`. Plus `MERGE_COMPLETE_ELIGIBLE_STATUSES = [user-questions, review-by-user, review-by-colleague]` and `prepareMergeCompletionPrompt`. | **These are RPC/GUI only — NOT in the `dev3` CLI** (no merge command). So to drive merge we either (a) keep PLAN's design and **drive git ourselves** (`GitPort`, full control, write-ahead, exactly-once — *recommended*), or (b) call the socket RPC `mergeTask`/`createPullRequest` (reuse dev-3.0 logic, but not built for our exactly-once/idempotency model). The plan's "we own git" stance stays the safer default. |
| Human "PR review" gate | **`review-by-colleague` ("PR Review") status + `peerReviewEnabled` + `githubAuthHost/Login`** — a built-in PR-review lane. | Map PLAN's `open_pr` merge policy onto this lane instead of inventing one. |
| Atomic lane moves | **`--if-status` / `--if-status-not` compare-and-set, enforced inside the server data-lock.** | Use directly — gives idempotent, race-free moves vs. the human, for free. No need to build our own CAS. |
| Parallel attempts | **`spawnVariants` / `addAttempts`** (multiple agent/config variants per task; tasks already carry `groupId`/`variantIndex`). | dev3-loop's fleet/guardrail logic can sit on top; don't reimplement variant spawning. |
| Auto-route stop target | **`getPrimaryStopTarget(autoReviewEnabled)`** → agents stop into `review-by-ai` (if enabled) else `review-by-user`. | Our reconciler must know which mode the project is in (read `project.autoReviewEnabled`) so it doesn't fight dev-3.0's own routing. |

**Net repositioning:** dev3-loop is *not* "add AI review + merge to dev-3.0" —
dev-3.0 has rudimentary versions of both. dev3-loop is the **autonomous,
rigorous, recoverable reconciler**: independent read-only grading
with structured verdicts, mechanical-checks-as-truth, the guardrail/cap/
oscillation/budget safety net, write-ahead exactly-once merge, level-triggered
convergence, and *policy-driven* progression — none of which dev-3.0 has. Update
PLAN §1 and README "what it is" to say this explicitly and to **disable or bypass
`builtinColumnAgents["review-by-ai"]`** so the two reviewers don't collide.

**Bonus seam:** the whole RPC surface (`tasks.list`, `task.move`, `mergeTask`,
`createPullRequest`, `getTerminalPreview`, `createCustomColumn`, …) is reachable
over `~/.dev3.0/sockets/<pid>.sock` via the CLI's `sendRequest` framing
(`src/cli/socket-client.ts`). The `dev3` CLI is a thin client over it. If the CLI
ever lacks a verb we need (e.g. merge, custom-column create), the socket is the
fallback — but it couples us to a running server and the wire format.

## Q5 — Can we reuse dev-3.0's `review-by-ai` as our grader? ✅ YES (with overrides)

**Verdict: reuse it for the M5 grader stage**, via three config overrides; it
preserves most of PLAN constraint #6 and saves building a separate grader runtime.

How it works (from `tmux-pty.ts:launchColumnAgent` + `task-lifecycle.ts:
triggerColumnAgentIfNeeded` + `shared-pure.ts:buildCmdScript`):
- Moving a task to `review-by-ai` launches a **fresh** agent
  (`resolveCommandForAgent(agentId, configId, …, {skipSystemPrompt:true})`) in a
  **new tmux pane** (split-window, 40%) in the worktree — **no producer
  conversation/scrollback inherited** ✅. Our `agentConfig.prompt` (with
  `{baseBranch}`→`origin/<base>`) is the task description; the diff is not
  auto-injected, so the prompt must run `git diff origin/<base>` itself.
- The launched agent = `builtinColumnAgents["review-by-ai"]` (per-project config).
  **Default is `builtin-claude`/`claude-bypass-sonnet` + a prompt that says "fix
  medium/high severity directly and commit"** — i.e. a same-family *fixer*, the
  opposite of an independent read-only grader.

**Reuse requires (else it violates the plan):**
1. **Override `builtinColumnAgents["review-by-ai"]`** = { an agentId/configId of
   our choosing (a different model is recommended but optional — it may even match
   the producer's), our adversarial **rubric prompt** that re-runs checks, diffs
   `origin/<base>`, writes `.dev3/review.json`, and says *do not edit* }.
   (Disabling instead: set `builtinColumnAgents` to an object *without* a
   `review-by-ai` key → no agent + no onExit hook → inert lane we fully own. If
   the key is entirely undefined, the default fixer runs — so never leave it
   unset when reusing.)
2. **Reconciler routes off `review.json`, not the lane.** The onExit hook is
   **hardcoded**: on **exit 0** the pane runs `dev3 task move --status
   review-by-user --if-status review-by-ai`. So `pass` → exits 0 → auto-advances
   to the human gate (desired ✅); `changes_requested` → our loop moves the card
   to `in-progress` first and the auto-move **no-ops** (guard `--if-status
   review-by-ai` fails) ✅; grader error (non-zero) → drops to a shell, no move →
   stall guardrail catches it ✅. Compatible on the happy path, neutralized on the
   unhappy one.

**What reuse does NOT give (neither does an out-of-band grader):** *hard*
read-only. The grader runs in the producer's worktree with the config's
permission mode; plan-mode would also block it writing `review.json`, so "never
edits code" stays prompt-level. Real protection = **we re-run checks + git is
truth**, so a rogue edit can't fake a pass. Optional hardening (either design):
grade in a throwaway worktree checked out at branch HEAD.

**When to go out-of-band instead (PLAN's original §8):** if you need hard input
isolation (grader sees only a diff, not the repo / `.dev3/progress.md`), full
routing control without the onExit move, or a headless/no-tmux grader. Keep the
`RuntimePort` abstraction so this is a swap, not a rewrite.

> **⚠ PLAN IMPACT (§8 grader):** make the grader stage a `RuntimePort` method
> whose default adapter = "move to `review-by-ai` with overridden
> `builtinColumnAgents`"; the domain still just emits `LaunchGrader` and reads the
> `review.json` verdict. Resolve in M4: exact path to set `builtinColumnAgents`
> per repo (repo `.dev3/config.json` via `dev3 config export`, app settings, or
> the `updateProjectSettings`/equivalent RPC).

## Net design deltas to fold into PLAN before M1

1. **Lane enum** → real status strings (`in-progress`, `review-by-ai`,
   `review-by-user`, `user-questions`, `todo`); treat `completed`/`cancelled` as
   observe-only terminal states we never write.
2. **Don't double-review** → moving a task to `review-by-ai` triggers dev-3.0's
   *own* review agent. dev3-loop must either disable
   `builtinColumnAgents["review-by-ai"]` (project config) or keep its independent
   grader out-of-band. Reconciler must also read `project.autoReviewEnabled` so it
   doesn't fight dev-3.0's stop-target routing. (See overlap §.)
3. **Merge trigger** → a custom column `ready_to_merge` **with no `agentConfig`**
   is viable and CLI-reachable (`task move --status <colId> --if-status <colId>`);
   a **label** is the no-setup alternative. Merge at the gate while the worktree
   is alive; never auto-`complete` (it's a blocking approval that destroys the
   worktree). Use `--if-status`/`--if-status-not` for race-free, idempotent moves.
4. **Reads from the JSON store, mutations via CLI** (`tasks list` has no `--json`
   branch — always a table). `dev3StorePath` defaults to `~/.dev3.0`; reader joins
   `projects.json` + `data/<slug>/tasks.json`; slug = path with `/`→`-`.
5. **branch = `dev3/task-<taskId8>`**, worktree = `task.worktreePath`; sibling
   `logs/`+`diffs/` dirs are candidate heartbeat/diff sources.
6. **Heartbeat** → prefer `getTerminalPreview` RPC / worktree mtimes / store
   fields over raw `capture-pane` (hangs on control-mode sessions); timeout-guard
   any direct tmux read.
7. **acceptanceCriteria** isn't structured — parse from `description` or hand the
   whole description to the grader.
8. **Lane enum** → 8 real statuses incl. `review-by-colleague` ("PR Review");
   `completed`/`cancelled` are observe-only (CLI can't set `cancelled`;
   `completed` is a blocking approval). Map PLAN `open_pr` → `review-by-colleague`.

## Still to confirm with the dev-3.0 author (all non-blocking — Fakes cover M1–M3)
- ~~Can a task be moved to a custom column via CLI?~~ **Yes** — `task move
  --status <customColumnId>`. Creating a column is RPC/GUI only.
- Do `worktrees/<slug>/<id8>/logs` and `/diffs` get populated during a run, and
  in what format? (decides heartbeat/diff source vs. `getTerminalPreview`)
- Does `getTerminalPreview` RPC avoid the control-mode hang our `capture-pane`
  hit? (decides the heartbeat/scrollback mechanism in M4)
- Best way to suppress dev-3.0's built-in `review-by-ai` agent per project so it
  doesn't collide with our independent grader (config flag vs. empty
  `builtinColumnAgents` entry).
