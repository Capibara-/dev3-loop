// End-to-end against a REAL headless `claude -p` reviewer (the production default command). This
// is the one test that exercises the actual agent invocation + permission mode + the real rubric:
// it builds a tiny repo with an origin, runs OutOfBandReviewer with DEFAULT_REVIEWER_COMMAND, and
// asserts the reviewer produced a SCHEMA-VALID .dev3/review.json (not a specific verdict — that's
// the model's call). Opt-in only — set DEV3_LOOP_REVIEWER_IT=1 — since it spawns a real agent
// (slow, costs tokens). Skipped when claude/git are absent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OutOfBandReviewer } from "../../src/adapters/review/out-of-band.ts";
import { reviewerRubric } from "../../src/domain/reviewer.ts";
import { exec } from "../../src/adapters/exec/index.ts";
import { shortId } from "../../src/adapters/dev3/index.ts";
import type { Card } from "../../src/domain/types.ts";
import type { ImplementorResult, Review } from "../../src/ports/dto.ts";
import type { RuntimePort } from "../../src/ports/runtime.ts";

declare const process: { env: Record<string, string | undefined> };

const RUN = process.env.DEV3_LOOP_REVIEWER_IT === "1";
const HAS_GIT = (await exec("git", ["--version"], { timeoutMs: 5_000 })).code === 0;
const HAS_CLAUDE = (await exec("claude", ["--version"], { timeoutMs: 10_000 })).code === 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function git(dir: string, args: readonly string[]): Promise<void> {
  const r = await exec("git", ["-C", dir, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`setup: git ${args.join(" ")} → ${r.stderr || r.stdout}`);
}

const inertBase: RuntimePort = {
  launchProducer: () => Promise.resolve(),
  launchGrader: () => Promise.resolve(),
  sendFixPrompt: () => Promise.resolve(),
  capture: () => Promise.resolve(null),
  isAlive: () => Promise.resolve(true),
  readResult: () => Promise.resolve<ImplementorResult | null>(null),
  readReview: () => Promise.resolve<Review | null>(null),
};

describe.skipIf(!RUN || !HAS_GIT || !HAS_CLAUDE)("OutOfBandReviewer × real claude -p", () => {
  let origin: string;
  let repo: string;
  let reviewRoot: string;
  let card: Card;

  beforeAll(async () => {
    origin = await mkdtemp(`${tmpdir()}/dev3-loop-rev-origin-`);
    await git(origin, ["init", "-q", "--bare"]);

    repo = await mkdtemp(`${tmpdir()}/dev3-loop-rev-repo-`);
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "ci@test.local"]);
    await git(repo, ["config", "user.name", "ci"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["checkout", "-q", "-b", "master"]);
    await writeFile(`${repo}/sum.js`, "export const sum = (a, b) => a + b;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "-q", "origin", "master"]);

    // A small, clean feature change on its own branch (origin/master is the diff base).
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(`${repo}/sum.js`, "export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "add mul"]);

    reviewRoot = await mkdtemp(`${tmpdir()}/dev3-loop-rev-root-`);

    card = {
      id: "claudee2e-0000-0000-0000-000000000000",
      repo: "owner/sample",
      baseBranch: "master",
      branch: "feature",
      worktreePath: repo,
      lane: "in-progress",
      prompt: "Add a `mul(a, b)` helper next to `sum`. Keep the existing code working.",
      acceptanceCriteria: ["A `mul` function multiplying its two arguments exists and is exported."],
      policy: {
        merge: "merge_when_green",
        maxConsecutiveFailures: 3,
        maxTotalAttempts: 6,
        stallMs: 1,
        implementor: { agent: "claude" },
        reviewer: { agent: "claude" },
        checksCmd: "node --check sum.js", // trivially runnable in the worktree, no deps
        reviewMode: "out-of-band",
      },
    };
  }, 60_000);

  afterAll(async () => {
    for (const d of [reviewRoot, repo, origin]) if (d) await rm(d, { recursive: true, force: true });
  });

  it("a real claude reviewer writes a schema-valid verdict", async () => {
    const reviewer = new OutOfBandReviewer({ base: inertBase, reviewRoot, cloneForReview: [] });
    await reviewer.launchGrader(card, card.policy.reviewer, reviewerRubric(card));

    let verdict: Review | null = null;
    for (let i = 0; i < 120 && verdict === null; i++) {
      await sleep(2_000); // real agent: poll up to ~4 min
      verdict = await reviewer.readReview(card);
    }

    // Assert the real invocation produced a structurally valid verdict — not a specific outcome.
    expect(verdict, "reviewer never wrote .dev3/review.json").not.toBeNull();
    expect(["pass", "changes_requested"]).toContain(verdict!.verdict);
    expect(typeof verdict!.ranChecks).toBe("boolean");
    expect(Array.isArray(verdict!.blocking)).toBe(true);
    expect(Array.isArray(verdict!.criteria)).toBe(true);

    // Sanity: the reviewer ran in the throwaway worktree, not the implementor's repo.
    const wt = `${reviewRoot}/${shortId(card.id)}`;
    const written = await readFile(`${wt}/.dev3/review.json`, "utf8");
    expect(written).toContain("verdict");
  }, 300_000);
});
