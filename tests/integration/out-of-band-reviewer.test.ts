// OutOfBandReviewer against real git worktrees in a tmpdir. Exercises the full launch lifecycle —
// throwaway worktree at branch HEAD, the (stubbed) reviewer writing .dev3/review.json there,
// readReview polling it, and the freshen-on-relaunch that clears a stale verdict. The reviewer
// command is stubbed with a deterministic `sh` script (no real agent), so this is fast and free;
// production swaps in `claude -p`. Skipped when `git` is absent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OutOfBandReviewer, type ReviewerCommand } from "../../src/adapters/review/out-of-band.ts";
import { exec } from "../../src/adapters/exec/index.ts";
import { shortId } from "../../src/adapters/dev3/index.ts";
import type { AgentSpec, Card } from "../../src/domain/types.ts";
import type { ImplementorResult, Review } from "../../src/ports/dto.ts";
import type { RuntimePort } from "../../src/ports/runtime.ts";

const HAS_GIT = (await exec("git", ["--version"], { timeoutMs: 5_000 })).code === 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function git(dir: string, args: readonly string[]): Promise<void> {
  const r = await exec("git", ["-C", dir, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`setup: git ${args.join(" ")} → ${r.stderr || r.stdout}`);
}

// A stub reviewer: writes a canned verdict into .dev3/review.json relative to its cwd (proving
// it ran in the throwaway worktree). Stands in for `claude -p` so the test is deterministic.
function stubReviewer(verdict: Review["verdict"]): ReviewerCommand {
  const json = JSON.stringify({ verdict, criteria: [], blocking: verdict === "pass" ? [] : ["fix"], ranChecks: true });
  return () => ({ bin: "sh", args: ["-c", `mkdir -p .dev3 && printf '%s' '${json}' > .dev3/review.json`] });
}

// A base RuntimePort that throws if a delegated (non-reviewer) method is reached unexpectedly.
const inertBase: RuntimePort = {
  launchProducer: () => Promise.resolve(),
  launchGrader: () => Promise.resolve(),
  sendFixPrompt: () => Promise.resolve(),
  capture: () => Promise.resolve(null),
  isAlive: () => Promise.resolve(true),
  readResult: () => Promise.resolve<ImplementorResult | null>(null),
  readReview: () => Promise.resolve<Review | null>(null),
};

const spec: AgentSpec = { agent: "claude" };

async function pollReview(r: OutOfBandReviewer, card: Card): Promise<Review | null> {
  for (let i = 0; i < 50; i++) {
    const v = await r.readReview(card);
    if (v) return v;
    await sleep(50);
  }
  return null;
}

describe.skipIf(!HAS_GIT)("OutOfBandReviewer (real git worktrees)", () => {
  let repo: string;
  let implWt: string;
  let reviewRoot: string;
  let card: Card;

  beforeAll(async () => {
    repo = await mkdtemp(`${tmpdir()}/dev3-loop-oob-`);
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "ci@test.local"]);
    await git(repo, ["config", "user.name", "ci"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["checkout", "-q", "-b", "master"]);
    await writeFile(`${repo}/a.txt`, "base\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    await git(repo, ["branch", "feature"]);

    // The implementor's worktree: a real worktree of the repo, on the feature branch.
    implWt = await mkdtemp(`${tmpdir()}/dev3-loop-oob-impl-`);
    await rm(implWt, { recursive: true, force: true });
    await git(repo, ["worktree", "add", "-q", implWt, "feature"]);
    await writeFile(`${implWt}/node_modules-marker`, "x"); // sentinel for the symlink check below

    reviewRoot = await mkdtemp(`${tmpdir()}/dev3-loop-oob-review-`);

    card = {
      id: "feature0-1111-2222-3333-444455556666",
      repo: "owner/sample",
      baseBranch: "master",
      branch: "feature",
      worktreePath: implWt,
      lane: "in-progress",
      prompt: "x",
      acceptanceCriteria: [],
      policy: {
        merge: "merge_when_green",
        maxConsecutiveFailures: 3,
        maxTotalAttempts: 6,
        stallMs: 1,
        implementor: { agent: "claude" },
        reviewer: { agent: "claude" },
        checksCmd: "true",
        reviewMode: "out-of-band",
      },
    };
  });

  afterAll(async () => {
    for (const d of [reviewRoot, implWt, repo]) if (d) await rm(d, { recursive: true, force: true });
  });

  it("readReview is null before any launch", async () => {
    const r = new OutOfBandReviewer({ base: inertBase, reviewRoot });
    expect(await r.readReview(card)).toBeNull();
  });

  it("launches the reviewer in a throwaway worktree at branch HEAD and reads its verdict", async () => {
    const r = new OutOfBandReviewer({
      base: inertBase, reviewRoot, reviewerCommand: stubReviewer("pass"), cloneForReview: ["node_modules-marker"],
    });
    await r.launchGrader(card, spec, "the rubric");

    const wt = `${reviewRoot}/${shortId(card.id)}`;
    // It is a real worktree checked out at the branch HEAD (the base file is present).
    expect((await readFile(`${wt}/a.txt`, "utf8"))).toBe("base\n");
    // cloneForReview symlinked the heavy dir so the reviewer can run the checks.
    expect((await readFile(`${wt}/node_modules-marker`, "utf8"))).toBe("x");

    const verdict = await pollReview(r, card);
    expect(verdict?.verdict).toBe("pass");
  });

  it("freshens on relaunch — a stale verdict is cleared before the new reviewer runs", async () => {
    const wt = `${reviewRoot}/${shortId(card.id)}`;
    // First launch leaves a pass verdict.
    const first = new OutOfBandReviewer({ base: inertBase, reviewRoot, reviewerCommand: stubReviewer("pass") });
    await first.launchGrader(card, spec, "rubric");
    expect((await pollReview(first, card))?.verdict).toBe("pass");

    // Relaunch with a reviewer that does nothing: the stale pass must have been cleared, so
    // readReview is null (not the old verdict) until/unless a new one is written.
    const noop: ReviewerCommand = () => ({ bin: "sh", args: ["-c", "true"] });
    const second = new OutOfBandReviewer({ base: inertBase, reviewRoot, reviewerCommand: noop });
    await second.launchGrader(card, spec, "rubric");
    await sleep(100);
    expect(await second.readReview(card)).toBeNull();
    void wt;
  });

  it("changes_requested verdict round-trips", async () => {
    const r = new OutOfBandReviewer({ base: inertBase, reviewRoot, reviewerCommand: stubReviewer("changes_requested") });
    await r.launchGrader(card, spec, "rubric");
    const verdict = await pollReview(r, card);
    expect(verdict?.verdict).toBe("changes_requested");
    expect(verdict?.blocking).toEqual(["fix"]);
  });
});
