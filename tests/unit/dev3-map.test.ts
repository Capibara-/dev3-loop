// Parse the committed dev-3.0 store fixture and project it to Card[] via the pure mapper — no
// socket, no server. Pins the store→domain mapping (lane passthrough, base-branch and
// branch-name fallbacks, implementor overlaid from agentId/configId).

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { taskToCard, type Dev3Project, type Dev3Task } from "../../src/adapters/dev3/index.ts";
import type { CardPolicy } from "../../src/domain/types.ts";

const BASE_POLICY: CardPolicy = {
  merge: "merge_when_green",
  maxConsecutiveFailures: 3,
  maxTotalAttempts: 6,
  stallMs: 600_000,
  implementor: { agent: "claude", config: "default" },
  reviewer: { agent: "gemini" },
  checksCmd: "bun run test",
};

async function loadFixture(): Promise<{ project: Dev3Project; tasks: Dev3Task[] }> {
  const projects = JSON.parse(
    await readFile("tests/fixtures/store/projects.json", "utf8"),
  ) as Dev3Project[];
  const tasks = JSON.parse(
    await readFile("tests/fixtures/store/data/home-ci-sample-repo/tasks.json", "utf8"),
  ) as Dev3Task[];
  return { project: projects[0]!, tasks };
}

describe("taskToCard (store fixture → Card[])", () => {
  it("maps a started task, overlaying the implementor from the store", async () => {
    const { project, tasks } = await loadFixture();
    const card = taskToCard(tasks[0]!, project, BASE_POLICY);

    expect(card.id).toBe("22222222-2222-2222-2222-222222222222");
    expect(card.repo).toBe("sample-repo");
    expect(card.baseBranch).toBe("master");
    expect(card.branch).toBe("dev3/task-22222222");
    expect(card.worktreePath).toBe(
      "/home/ci/.dev3.0/worktrees/home-ci-sample-repo/22222222/worktree",
    );
    expect(card.lane).toBe("in-progress");
    expect(card.prompt).toContain("GET /healthz");
    expect(card.acceptanceCriteria).toEqual([]);
    // implementor from agentId/configId; the rest of the policy is the base.
    expect(card.policy.implementor).toEqual({ agent: "claude", config: "claude-default-opus48" });
    expect(card.policy.merge).toBe("merge_when_green");
    expect(card.policy.reviewer).toEqual({ agent: "gemini" });
  });

  it("falls back to derived branch + project base branch for an unstarted task", async () => {
    const { project, tasks } = await loadFixture();
    const card = taskToCard(tasks[1]!, project, BASE_POLICY);

    expect(card.lane).toBe("todo");
    expect(card.worktreePath).toBeNull();
    expect(card.branch).toBe("dev3/task-33333333"); // derived from the id (branchName null)
    expect(card.baseBranch).toBe("master"); // from project.defaultBaseBranch (task baseBranch null)
    expect(card.policy.implementor).toEqual(BASE_POLICY.implementor); // no store agent → base
  });
});
