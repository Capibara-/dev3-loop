// Ambient declarations for the node built-ins / globals the adapter layer uses (the repo keeps
// tsconfig types: [] — no @types/node, network install blocked, see AGENTS.md). Declared in one
// place to avoid duplicate-global clashes; Bun and node both implement all of these. node:net
// and node:os live in dev3-shims.d.ts; node:fs/promises in fs/node-shims.d.ts.

declare module "node:child_process" {
  export interface Readable {
    on(event: "data", cb: (chunk: Uint8Array) => void): this;
  }
  export interface ChildProcess {
    readonly pid: number | undefined;
    readonly killed: boolean;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    on(event: "close", cb: (code: number | null) => void): this;
    on(event: "error", cb: (err: Error) => void): this;
    kill(signal?: string | number): boolean;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    opts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdio?: "ignore" | "pipe";
    },
  ): ChildProcess;
}

declare const Buffer: {
  concat(list: readonly Uint8Array[]): { toString(encoding: "utf8"): string };
};
declare function setTimeout(handler: () => void, ms: number): number;
declare function clearTimeout(id: number): void;
