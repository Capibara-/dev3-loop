// dev3-server CLI-socket client. // DISCOVERY (verified against the real server, 2026-06):
// the protocol is NOT HTTP and NOT JSON-RPC 2.0 — it is newline-delimited JSON over a unix
// socket at <dev3Home>/sockets/<pid>.sock, one request → one response, and the server CLOSES
// the connection after replying. Request:  {method, params}\n  (a trailing \n is the message
// delimiter; without it the server hangs). Response envelope:
//   success → {ok: true,  data: <payload>}
//   failure → {ok: false, error: "<message>"}
// Reads (tasks.list/projects.list) go through here; board MUTATIONS go through the `dev3` CLI.

import { connect } from "node:net";
import { readdir } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 5_000;

interface RpcEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// Call one method and return its `data`. Rejects on a non-ok envelope, a closed-without-reply
// socket, malformed JSON, or timeout. Always tears the socket down.
export function rpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const chunks: Uint8Array[] = [];
    let settled = false;

    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        // already gone
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`dev3 rpc ${method}: timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );

    sock.on("connect", () => sock.write(`${JSON.stringify({ method, params })}\n`));
    sock.on("data", (chunk) => chunks.push(chunk));
    sock.on("error", (e) => finish(new Error(`dev3 rpc ${method}: ${e.message}`)));
    sock.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        finish(new Error(`dev3 rpc ${method}: connection closed with no response`));
        return;
      }
      let env: RpcEnvelope;
      try {
        env = JSON.parse(text) as RpcEnvelope;
      } catch (e) {
        finish(new Error(`dev3 rpc ${method}: malformed response: ${(e as Error).message}`));
        return;
      }
      if (!env.ok) {
        finish(new Error(`dev3 rpc ${method}: ${env.error ?? "not ok"}`));
        return;
      }
      finish(null, env.data);
    });
  });
}

// Locate the live server socket under <dev3Home>/sockets. // DISCOVERY: the server names its
// socket <pid>.sock; in normal use there is exactly one. If several linger (a stale socket from
// a crashed server), we cannot tell the live one from a name alone, so we pick the
// lexicographically-last and leave it to the caller's timeout to fail over a dead one.
export async function findSocket(dev3Home: string): Promise<string> {
  const dir = `${dev3Home}/sockets`;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".sock"));
  } catch {
    throw new Error(`dev3: no sockets directory at ${dir} (is dev3-server running?)`);
  }
  if (names.length === 0) throw new Error(`dev3: no socket under ${dir} (is dev3-server running?)`);
  names.sort();
  return `${dir}/${names[names.length - 1]}`;
}
