// The mutation side of the board seam, driven through the `dev3` CLI so the server stays the
// single writer of its store. Reads delegate to Dev3RpcReader (tasks.list over the socket).
// Every task-scoped command carries --task <id> (a uuid, globally resolvable) so it works from
// outside the task's worktree. Moves use --if-status as a server-enforced compare-and-set: a
// guard miss is a no-op, not an error (the human may have moved the card since we observed it).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Card, CustomColumnId, Lane } from "../../domain/types.ts";
import type { BoardPort } from "../../ports/board.ts";
import { exec, type ExecResult } from "../exec/index.ts";
import type { Dev3RpcReader } from "./reader.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
// Inline notes/overviews above this length (or with a leading @ / newlines) are passed via the
// CLI's @file syntax instead, to dodge @-arg interpretation and arg-length limits.
const INLINE_MAX = 2_000;

export interface Dev3CliBoardOptions {
  dev3Bin?: string; // path to the `dev3` CLI; default "dev3" (on PATH)
  cwd?: string; // working dir for CLI invocations
  env?: Record<string, string | undefined>; // CLI env (e.g. HOME, to target a specific store)
  timeoutMs?: number;
}

export class Dev3CliBoard implements BoardPort {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly reader: Dev3RpcReader,
    private readonly opts: Dev3CliBoardOptions = {},
  ) {
    this.bin = opts.dev3Bin ?? "dev3";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  listCards(): Promise<Card[]> {
    return this.reader.listCards();
  }

  async moveCard(
    id: string,
    to: Lane | CustomColumnId,
    expect?: Lane | CustomColumnId,
  ): Promise<void> {
    const args = ["task", "move", "--task", id, "--status", to];
    if (expect !== undefined) args.push("--if-status", expect);
    const r = await this.run(args);
    // // DISCOVERY: a guard miss is a server-side no-op reported as SUCCESS — `dev3 task move`
    // exits 0 and prints "Moved task <id> → <current lane>" when --if-status doesn't match. So a
    // non-zero exit is always a genuine failure (e.g. an illegal status transition), never the
    // expected race, and is surfaced.
    if (r.code !== 0) throw cliError("task move", args, r);
  }

  async addNote(id: string, note: string): Promise<void> {
    await this.withArg(note, async (arg) => {
      const r = await this.run(["note", "add", arg, "--task", id]);
      if (r.code !== 0) throw cliError("note add", ["note", "add", "--task", id], r);
    });
  }

  async setOverview(id: string, text: string): Promise<void> {
    await this.withArg(text, async (arg) => {
      const r = await this.run(["overview", "set", arg, "--task", id]);
      if (r.code !== 0) throw cliError("overview set", ["overview", "set", "--task", id], r);
    });
  }

  private run(args: readonly string[]): Promise<ExecResult> {
    return exec(this.bin, args, {
      ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
      timeoutMs: this.timeoutMs,
    });
  }

  // Pass `body` inline when it is short and safe; otherwise stage it in a temp file and pass
  // @path (the CLI reads @-prefixed args from a file), cleaning the file up afterward.
  private async withArg(body: string, use: (arg: string) => Promise<void>): Promise<void> {
    if (body.length <= INLINE_MAX && !body.startsWith("@") && !body.includes("\n")) {
      await use(body);
      return;
    }
    const dir = await mkdtemp(`${tmpdir()}/dev3-loop-note-`);
    const file = `${dir}/body.md`;
    try {
      await writeFile(file, body);
      await use(`@${file}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function cliError(label: string, args: readonly string[], r: ExecResult): Error {
  const reason = r.timedOut ? "timed out" : `exit ${r.code}`;
  const detail = (r.stderr || r.stdout).trim();
  return new Error(`dev3 ${label} failed (${reason}): ${detail || `[${args.join(" ")}]`}`);
}
