// GitCli against a throwaway local repo (no remote, no gh) — diff, checks (green + red), and the
// idempotent merge / content-aware isMerged round-trip. Skipped when `git` is absent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitCli } from "../../src/adapters/git/index.ts";
import { exec } from "../../src/adapters/exec/index.ts";
import type { Card } from "../../src/domain/types.ts";

const HAS_GIT = (await exec("git", ["--version"], { timeoutMs: 5_000 })).code === 0;

async function git(dir: string, args: readonly string[]): Promise<void> {
  const r = await exec("git", ["-C", dir, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`setup: git ${args.join(" ")} → ${r.stderr || r.stdout}`);
}

describe.skipIf(!HAS_GIT)("GitCli (real git, throwaway repo)", () => {
  let repo: string;
  let card: Card;
  const cli = new GitCli();

  beforeAll(async () => {
    repo = await mkdtemp(`${tmpdir()}/dev3-loop-git-`);
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "ci@test.local"]);
    await git(repo, ["config", "user.name", "ci"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["checkout", "-q", "-b", "master"]);
    await writeFile(`${repo}/a.txt`, "base\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(`${repo}/b.txt`, "feature work\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "feature"]);

    card = {
      id: "feature0-0000-0000-0000-000000000000",
      repo: "owner/sample",
      baseBranch: "master",
      branch: "feature",
      worktreePath: repo,
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
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("diff shows the branch's changes vs base", async () => {
    const diff = await cli.diff(card);
    expect(diff).toContain("b.txt");
    expect(diff).toContain("feature work");
  });

  it("runChecks reports green and red from the exit code", async () => {
    const green = await cli.runChecks(card, "true");
    expect(green.passed).toBe(true);
    expect(green.exitCode).toBe(0);

    const red = await cli.runChecks(card, "echo boom >&2; exit 1");
    expect(red.passed).toBe(false);
    expect(red.exitCode).toBe(1);
    expect(red.stderr).toContain("boom");
  });

  it("merges exactly once and reports isMerged content-awarely", async () => {
    expect(await cli.isMerged(card)).toBe(false);

    const first = await cli.merge(card);
    expect(first.merged).toBe(true);
    expect(first.alreadyMerged).toBe(false);
    expect(first.commit).toBeTruthy();

    expect(await cli.isMerged(card)).toBe(true);

    // Idempotent: a second merge is a no-op that reports alreadyMerged (the exactly-once guard).
    const second = await cli.merge(card);
    expect(second.merged).toBe(true);
    expect(second.alreadyMerged).toBe(true);
  });
});
