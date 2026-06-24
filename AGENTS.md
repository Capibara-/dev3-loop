# AGENTS.md — conventions for agents working on dev3-loop

> Stub created in M0/T1. Expand per PLAN.md §14 (pure-domain rule, no I/O in
> `domain/`, test-first, atomic writes) as the codebase grows.

## Toolchain

- **Runtime is Bun.** Gates: `bun run typecheck` (`tsc --noEmit`) and `bun run test` (`vitest run`).
- **Dependencies auto-install per worktree.** `.dev3/config.json` sets
  `setupScript: "bun install"` and `clonePaths: ["node_modules"]`, so every new
  dev-3.0 worktree gets deps automatically (CoW-cloned, or installed) — you should
  not need to install by hand. If you add a dependency and must install manually,
  see the caveats below.
- **Bun lives under a specific fnm Node version** (`v20.19.1`) on this machine —
  `which bun` is an fnm shim, global only for that Node version. Switching Node
  versions via fnm hides it; reinstall there (`npm install -g bun`) if so.
- **The Bash tool is sandboxed with no network**, and `bun.sh` is network-blocked.
  A manual `bun install` must run with the sandbox disabled; `typecheck`/`test`
  run fine sandboxed (no network needed). The `setupScript` runs outside the
  sandbox, so the normal worktree-setup path is unaffected.

## Git workflow

- **NEVER commit or push without running the e2e tests locally first.** `bun run test`
  (and CI) **skip** the real-server integration suite — it's opt-in. Before any commit or
  push, run `bun run test:e2e` (boots a fully HOME-isolated real `dev3-server`; needs the
  `dev3-server` binary present) alongside `bun run typecheck` and `bun run test`. The gated
  suite is exactly where adapter/protocol regressions hide, so the standard gate passing is
  not enough.
- **Every task: commit → push → open a PR when it's ready for review.** Don't leave
  finished work sitting only in the local worktree.
- Commit your work in focused commits on the task branch (already named per the
  dev-3.0 convention, e.g. `feat/dev3-…`).
- Push the branch: `git push -u origin <branch>`.
- Open a PR against `master` for the user's review: `gh pr create --base master
  --fill` (expand the body with what changed + how it was verified).
- Do this once the task's Definition of Done is met (gates green); the PR is the
  review surface — the user reviews and merges.
