/**
 * Minimal ambient declarations for the Node/Bun built-ins the `fs` adapters use.
 *
 * The repo keeps tsconfig `types: []` (no `@types/node` — a network install is
 * blocked on this machine, see AGENTS.md), so — mirroring the `declare const Bun`
 * shims in `cli.ts`/`config.ts` — we declare just the slice of `node:fs/promises`
 * and `node:os` these adapters actually touch. Bun implements both natively.
 *
 * @module adapters/fs/node-shims
 */

declare module "node:fs/promises" {
  /** Create a directory (with `recursive` to make parents + no-op if it exists). */
  export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
  /** List the entries of a directory (names only). */
  export function readdir(path: string): Promise<string[]>;
  /** Read a UTF-8 text file. */
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  /** Write a file in full (used for the `.tmp` staging file of an atomic write). */
  export function writeFile(path: string, data: string): Promise<void>;
  /** Append to a file, creating it if absent (the NDJSON event log). */
  export function appendFile(path: string, data: string): Promise<void>;
  /** Atomically rename `from` → `to` (POSIX `rename(2)`; the atomicity guarantee). */
  export function rename(from: string, to: string): Promise<void>;
  /** Make a unique temp dir from a prefix; returns the created path (tests). */
  export function mkdtemp(prefix: string): Promise<string>;
  /** Remove a path (tests cleanup). */
  export function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module "node:os" {
  /** The OS temp directory (tests). */
  export function tmpdir(): string;
}
