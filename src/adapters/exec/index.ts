// The subprocess seam: every real adapter (git, gh, dev3, tmux) shells out through this one
// timeout-guarded primitive. Timeout-guarding is load-bearing, not a nicety — a hung child
// (e.g. capture-pane on a control-mode tmux session) must NEVER stall the reconcile tick, so
// exec always resolves: on timeout it kills the child and returns timedOut:true rather than
// hanging. Never throws — a missing binary resolves as exit 127 so callers can fall back; the
// caller decides what any exit code means.
//
// Built on node:child_process (implemented by both Bun — the production runtime — and node,
// where vitest's workers run), so the one code path works under either.

import { spawn } from "node:child_process";

export interface ExecResult {
  code: number; // child exit code; 127 ⇒ spawn failed (e.g. missing binary)
  stdout: string;
  stderr: string;
  timedOut: boolean; // true ⇒ we killed it at timeoutMs; code/stdout/stderr are partial
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number; // omitted ⇒ no timeout (use only for commands that always terminate)
  env?: Record<string, string | undefined>;
}

// Run `cmd args…` to completion (no shell — args are passed verbatim, so no quoting/escaping).
// Always resolves; inspect `code`/`timedOut`.
export function exec(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      stdio: "pipe",
    });

    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let timedOut = false;
    let settled = false;
    let timer: number | undefined;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    };

    child.stdout?.on("data", (c) => out.push(c));
    child.stderr?.on("data", (c) => err.push(c));
    // Spawn failure (ENOENT etc.): no close event fires, so resolve here as 127.
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: e.message, timedOut });
    });
    child.on("close", (code) => finish(code ?? -1));

    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, opts.timeoutMs);
    }
  });
}
