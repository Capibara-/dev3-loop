# AGENTS.md — conventions for agents working on dev3-loop

> Stub created in M0/T1. Expand per PLAN.md §14 (pure-domain rule, no I/O in
> `domain/`, test-first, atomic writes) as the codebase grows.

## Toolchain

- **Runtime is Bun.** Gates: `bun run typecheck` (`tsc --noEmit`) and `bun run test` (`vitest run`).
- **Bun install on this machine:** not preinstalled, and `bun.sh` is network-blocked here.
  Installed via `npm install -g bun` → lives under fnm Node **v20.19.1**
  (`which bun` is an fnm shim). It is global only for that Node version; switching
  Node versions via fnm hides it — reinstall there if so.
- **Bash tool is sandboxed with no network.** `bun install` must run with the
  sandbox disabled; `typecheck`/`test` run fine sandboxed (no network needed).
