// TmuxRuntime against real tmux on a throwaway -L socket (never the live `dev3` one). Exercises
// session liveness, the send-keys → capture-pane round-trip, and isAlive after the session is
// killed. Skipped when `tmux` is absent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxRuntime } from "../../src/adapters/tmux/index.ts";
import { exec } from "../../src/adapters/exec/index.ts";
import type { Card } from "../../src/domain/types.ts";

declare const process: { pid: number };
declare const Date: { now(): number };

const HAS_TMUX = (await exec("tmux", ["-V"], { timeoutMs: 5_000 })).code === 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const card: Card = {
  id: "abcdef12-0000-0000-0000-000000000000", // session → dev3-abcdef12
  repo: "owner/sample",
  baseBranch: "master",
  branch: "dev3/task-abcdef12",
  worktreePath: null,
  lane: "in-progress",
  prompt: "x",
  acceptanceCriteria: [],
  policy: {
    merge: "merge_when_green",
    maxConsecutiveFailures: 3,
    maxTotalAttempts: 6,
    stallMs: 1,
    implementor: { agent: "claude" },
    reviewer: { agent: "gemini" },
    checksCmd: "true",
  },
};

describe.skipIf(!HAS_TMUX)("TmuxRuntime (real tmux, throwaway socket)", () => {
  const socketName = `dev3-loop-it-${process.pid}-${Date.now()}`;
  const session = "dev3-abcdef12";
  const tmux = (args: readonly string[]) => exec("tmux", ["-L", socketName, ...args], { timeoutMs: 5_000 });
  const runtime = new TmuxRuntime({ socketName });

  beforeAll(async () => {
    await tmux(["new-session", "-d", "-s", session, "-x", "200", "-y", "50"]);
  });

  afterAll(async () => {
    await tmux(["kill-server"]);
  });

  it("isAlive is true for a live session", async () => {
    expect(await runtime.isAlive(card)).toBe(true);
  });

  it("send-keys → capture-pane round-trips the text", async () => {
    await runtime.sendFixPrompt(card, "echo HELLO_MARKER_123");
    let pane = "";
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      pane = (await runtime.capture(card)) ?? "";
      if (pane.includes("HELLO_MARKER_123")) break;
    }
    expect(pane).toContain("HELLO_MARKER_123");
  });

  it("isAlive is false after the session is killed", async () => {
    await tmux(["kill-session", "-t", session]);
    expect(await runtime.isAlive(card)).toBe(false);
    expect(await runtime.capture(card)).toBeNull();
  });
});
