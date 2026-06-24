// Ambient declarations for the node built-ins / globals the dev3 socket client touches. The
// repo keeps tsconfig types: [] (no @types/node — network install is blocked, see AGENTS.md),
// so — like adapters/fs/node-shims.d.ts — we declare just the slice we use. Bun implements all
// of these natively. node:os here only adds `homedir`; it merges with the os block in
// adapters/fs/node-shims.d.ts.

declare module "node:net" {
  export interface Socket {
    on(event: "connect", cb: () => void): this;
    on(event: "data", cb: (chunk: Uint8Array) => void): this;
    on(event: "close", cb: () => void): this;
    on(event: "error", cb: (err: Error) => void): this;
    write(data: string): boolean;
    destroy(err?: Error): void;
  }
  export function connect(path: string): Socket;
}

declare module "node:os" {
  export function homedir(): string;
}
