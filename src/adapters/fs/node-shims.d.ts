// Minimal ambient declarations for the Node/Bun built-ins the fs adapters use. The repo keeps
// tsconfig types: [] (no @types/node — a network install is blocked, see AGENTS.md), so —
// mirroring the `declare const Bun` shims in cli.ts/config.ts — we declare just the slice of
// node:fs/promises and node:os these adapters touch. Bun implements both natively.

declare module "node:fs/promises" {
  export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
  export function readdir(path: string): Promise<string[]>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function appendFile(path: string, data: string): Promise<void>;
  export function rename(from: string, to: string): Promise<void>; // POSIX rename(2) — the atomicity guarantee
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}
