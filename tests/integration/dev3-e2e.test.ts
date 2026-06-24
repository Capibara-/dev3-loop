// End-to-end against a REAL, fully isolated dev3-server. Boots the server under a
// throwaway HOME (so it never touches the user's ~/.dev3.0), seeds a mock project + task by
// writing the store before boot, then drives the real adapters: Dev3RpcReader.listCards over
// the socket and Dev3CliBoard mutations through the `dev3` CLI (incl. the --if-status CAS
// guard-miss no-op). Opt-in only — set DEV3_LOOP_IT=1 — so normal CI never spawns a server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Dev3CliBoard, Dev3RpcReader, rpc } from "../../src/adapters/dev3/index.ts";
import type { CardPolicy } from "../../src/domain/types.ts";

declare const process: { env: Record<string, string | undefined> };
declare const Date: { now(): number };

const RUN_E2E = process.env.DEV3_LOOP_IT === "1";
const HOME = process.env.HOME ?? "";
const SERVER_BIN = `${HOME}/.dev3.0/bin/dev3-server`;
const DEV3_BIN = `${HOME}/.dev3.0/bin/dev3`;

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "22222222-2222-2222-2222-222222222222";
const PROJECT_PATH = "/tmp/mock-repo";
const SLUG = "tmp-mock-repo";

const BASE_POLICY: CardPolicy = {
  merge: "merge_when_green",
  maxConsecutiveFailures: 3,
  maxTotalAttempts: 6,
  stallMs: 600_000,
  implementor: { agent: "claude" },
  reviewer: { agent: "gemini" },
  checksCmd: "true",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function seed(dev3Home: string): Promise<void> {
  await mkdir(`${dev3Home}/data/${SLUG}`, { recursive: true });
  await mkdir(`${dev3Home}/sockets`, { recursive: true });
  await writeFile(
    `${dev3Home}/projects.json`,
    JSON.stringify([
      {
        id: PROJECT_ID, name: "mock-repo", path: PROJECT_PATH,
        setupScript: "", setupScriptLaunchMode: "parallel", devScript: "", cleanupScript: "",
        defaultBaseBranch: "master", clonePaths: [], createdAt: "2026-01-01T00:00:00.000Z",
        labels: [], customColumns: [],
      },
    ]),
  );
  await writeFile(
    `${dev3Home}/data/${SLUG}/tasks.json`,
    JSON.stringify([
      {
        id: TASK_ID, seq: 1, projectId: PROJECT_ID, title: "Mock task", description: "mock body",
        status: "todo", baseBranch: "master", worktreePath: null, branchName: null,
        agentId: "builtin-claude", configId: "claude-default-opus48",
        customColumnId: null, labelIds: [], notes: [], overview: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
  );
}

async function waitForSocket(dev3Home: string, timeoutMs: number): Promise<string> {
  const dir = `${dev3Home}/sockets`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const socks = (await readdir(dir)).filter((f) => f.endsWith(".sock"));
      if (socks[0] !== undefined) return `${dir}/${socks[0]}`;
    } catch {
      // sockets dir not created yet
    }
    await sleep(200);
  }
  throw new Error("isolated dev3-server socket never appeared");
}

describe.skipIf(!RUN_E2E)("dev3 adapters (isolated real server)", () => {
  let tmpHome: string;
  let server: ChildProcess;
  let socketPath: string;
  let reader: Dev3RpcReader;
  let board: Dev3CliBoard;

  beforeAll(async () => {
    tmpHome = await mkdtemp(`${tmpdir()}/dev3-loop-e2e-`);
    const dev3Home = `${tmpHome}/.dev3.0`;
    await seed(dev3Home);
    server = spawn(SERVER_BIN, [], { env: { ...process.env, HOME: tmpHome }, stdio: "ignore" });
    socketPath = await waitForSocket(dev3Home, 20_000);
    reader = new Dev3RpcReader({ projectId: PROJECT_ID, basePolicy: BASE_POLICY, socketPath });
    board = new Dev3CliBoard(reader, {
      dev3Bin: DEV3_BIN,
      cwd: tmpHome,
      env: { ...process.env, HOME: tmpHome },
    });
  }, 30_000);

  afterAll(async () => {
    if (server && !server.killed) server.kill("SIGKILL");
    if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  });

  it("never binds the real socket", () => {
    expect(socketPath.startsWith(tmpHome)).toBe(true);
  });

  it("listCards reads the seeded task over the socket", async () => {
    const cards = await reader.listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(TASK_ID);
    expect(cards[0]!.lane).toBe("todo");
    expect(cards[0]!.policy.implementor).toEqual({ agent: "claude", config: "claude-default-opus48" });
  });

  it("moveCard with a stale guard is a no-op, not an error", async () => {
    // Guard expects review-by-user but the card is todo ⇒ the move must not happen and must not
    // throw. A legal target (in-progress) is used so the ONLY reason it no-ops is the guard miss
    // — and since the move never lands, no worktree/agent is ever spawned.
    await expect(board.moveCard(TASK_ID, "in-progress", "review-by-user")).resolves.toBeUndefined();
    const cards = await reader.listCards();
    expect(cards[0]!.lane).toBe("todo"); // unchanged
  });

  it("moveCard surfaces an illegal transition as an error", async () => {
    // DISCOVERY: dev-3.0 enforces legal transitions; todo → user-questions is rejected (exit 1).
    await expect(board.moveCard(TASK_ID, "user-questions", "todo")).rejects.toThrow(/Cannot move/);
  });

  it("addNote + setOverview persist to the task record", async () => {
    await board.addNote(TASK_ID, "e2e note body");
    await board.setOverview(TASK_ID, "e2e overview");
    const tasks = (await rpc(socketPath, "tasks.list", { projectId: PROJECT_ID })) as Array<{
      id: string;
      overview: string | null;
      notes: Array<{ body?: string } | string>;
    }>;
    const task = tasks.find((t) => t.id === TASK_ID)!;
    expect(task.overview).toBe("e2e overview");
    const noteBlob = JSON.stringify(task.notes);
    expect(noteBlob).toContain("e2e note body");
  });
});
