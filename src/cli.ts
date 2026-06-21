#!/usr/bin/env bun
/**
 * `dev3-loop` CLI entrypoint (M0/T2 — PLAN.md §12).
 *
 * Argument parsing lives in the pure {@link parseArgs} so it is unit-testable
 * without touching `process`/`Bun`.
 *
 * **Wiring status (M1, T10).** `run`/`dry-run` are the front door to the
 * reconcile loop: the composition root + interval runner + dry-run mode are
 * implemented and exercised against in-memory Fakes (`startReconciler` in
 * {@link module:app/loop}; see the loop tests). They cannot run end-to-end yet
 * because the **real dev-3.0 adapters land in M4** (board/runtime/git/journal)
 * and the dry-run E2E is M7 (PLAN §15/§16) — so the CLI commands still report
 * "not implemented yet" while the loop core they will drive is done. `replay` is
 * M2 and `preflight` is M4.
 */

// The repo's tsconfig keeps `types: []`, so Node/Bun globals are not in scope.
// Declare the tiny surface this file actually uses rather than pulling in
// @types/node / @types/bun (a network install on this machine — see AGENTS.md).
declare const process: { argv: readonly string[]; exit(code?: number): never };
declare const console: {
  log(...args: readonly unknown[]): void;
  error(...args: readonly unknown[]): void;
};
declare global {
  interface ImportMeta {
    /** Bun: true when this module is the program entrypoint. */
    readonly main: boolean;
  }
}

/** Subcommands the loop will eventually expose (PLAN.md §12). */
export const SUBCOMMANDS = ["run", "dry-run", "replay", "preflight"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

/** Pure result of {@link parseArgs}; never performs I/O. */
export type ParseResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; command: Subcommand }
  | { kind: "none" } // no subcommand supplied
  | { kind: "unknown"; arg: string };

/** Short, human-readable description of each subcommand (used in `--help`). */
const SUBCOMMAND_HELP: Record<Subcommand, string> = {
  run: "Reconcile the board continuously (not implemented yet)",
  "dry-run": "Print the action plan without mutating anything (not implemented yet)",
  replay: "Rebuild journal state from the event log (not implemented yet)",
  preflight: "Validate the dev-3.0 store + config before running (not implemented yet)",
};

/**
 * Per-command status line printed when a subcommand is invoked. The loop core
 * `run`/`dry-run` will drive is implemented (T10); the missing piece is the real
 * dev-3.0 adapters (M4) — so each still reports "not implemented yet" with the
 * milestone that unblocks it.
 */
const SUBCOMMAND_STATUS: Record<Subcommand, string> = {
  run: "run: not implemented yet — reconcile loop is wired (app/loop startReconciler) but the real dev-3.0 adapters land in M4",
  "dry-run": "dry-run: not implemented yet — the loop's dry-run mode is implemented + tested against fakes; the E2E command lands in M7 (needs M4 adapters)",
  replay: "replay: not implemented yet (M2)",
  preflight: "preflight: not implemented yet (M4)",
};

/** Version string, single-sourced from package.json. */
import pkg from "../package.json" with { type: "json" };
export const VERSION: string = (pkg as { version: string }).version;

/** Render the usage / help text. */
export function usage(): string {
  const lines = [
    "dev3-loop — autonomous reconciler for dev-3.0 boards",
    "",
    "Usage: dev3-loop <command> [options]",
    "",
    "Commands:",
    ...SUBCOMMANDS.map((c) => `  ${c.padEnd(10)} ${SUBCOMMAND_HELP[c]}`),
    "",
    "Options:",
    "  -h, --help     Print this help and exit",
    "  -v, --version  Print the version and exit",
  ];
  return lines.join("\n");
}

/**
 * Parse `argv` (args only — already sliced past `bun`/script) into a
 * {@link ParseResult}. Pure: it inspects the first positional token and never
 * writes output or exits.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const first = argv[0];
  if (first === undefined) return { kind: "none" };
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first === "-v" || first === "--version") return { kind: "version" };
  if ((SUBCOMMANDS as readonly string[]).includes(first)) {
    return { kind: "command", command: first as Subcommand };
  }
  return { kind: "unknown", arg: first };
}

/** Sink for CLI output; injectable so {@link run} stays testable. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/**
 * Execute the CLI for the given args and return the process exit code.
 * Does no process-level side effects beyond writing to `io`.
 */
export function run(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case "help":
      io.out(usage());
      return 0;
    case "version":
      io.out(VERSION);
      return 0;
    case "none":
      io.err("error: no command given\n");
      io.err(usage());
      return 1;
    case "unknown":
      io.err(`error: unknown command '${parsed.arg}'\n`);
      io.err(usage());
      return 1;
    case "command":
      io.out(SUBCOMMAND_STATUS[parsed.command]);
      return 0;
  }
}

const consoleIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

if (import.meta.main) {
  process.exit(run(process.argv.slice(2), consoleIo));
}
