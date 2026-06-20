#!/usr/bin/env bun
/**
 * `dev3-loop` CLI entrypoint (M0/T2 — PLAN.md §12).
 *
 * Subcommand handlers are stubs that print "not implemented yet"; they get
 * wired up in later milestones (run=M7+, dry-run=M7, replay=M2, doctor=M4).
 * Argument parsing lives in the pure {@link parseArgs} so it is unit-testable
 * without touching `process`/`Bun`.
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
export const SUBCOMMANDS = ["run", "dry-run", "replay", "doctor"] as const;
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
  doctor: "Locate and validate the dev-3.0 store + config (not implemented yet)",
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
    ...SUBCOMMANDS.map((c) => `  ${c.padEnd(9)} ${SUBCOMMAND_HELP[c]}`),
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
      io.out(`${parsed.command}: not implemented yet`);
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
