// GitCli's GitHub merge path, driven by a STUBBED `gh` (no network, no real GitHub). The stub
// keeps PR state in a directory ($GH_STUB_STATE): `pr create` opens it, `pr merge --auto` arms it
// (does NOT merge — auto-merge is async), and the test simulates GitHub firing the merge by
// touching a `merged` marker. Proves: (1) an armed auto-merge returns `pending`, not merged or a
// failure; (2) once the remote reflects the merge, merge() reports alreadyMerged (exactly-once);
// (3) isMerged is squash-safe — the PR's MERGED state wins over a false local ancestry result.
// Skipped when `git` is absent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitCli } from "../../src/adapters/git/index.ts";
import { exec } from "../../src/adapters/exec/index.ts";
import type { Card } from "../../src/domain/types.ts";

declare const process: { env: Record<string, string | undefined> };

const HAS_GIT = (await exec("git", ["--version"], { timeoutMs: 5_000 })).code === 0;

async function git(dir: string, args: readonly string[]): Promise<void> {
  const r = await exec("git", ["-C", dir, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`setup: git ${args.join(" ")} → ${r.stderr || r.stdout}`);
}

// A `gh` that fakes a GitHub repo + PR lifecycle from marker files under $GH_STUB_STATE.
const GH_STUB = `#!/usr/bin/env bash
S="\${GH_STUB_STATE:?}"
if [ "$1" = "--version" ]; then echo "gh stub 1.0"; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo '{"url":"https://github.com/owner/repo"}'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$S/merged" ]; then echo '{"state":"MERGED","url":"https://github.com/owner/repo/pull/1"}'; exit 0; fi
  if [ -f "$S/pr" ]; then echo '{"state":"OPEN","url":"https://github.com/owner/repo/pull/1"}'; exit 0; fi
  echo "no pull requests found" >&2; exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then touch "$S/pr"; echo "https://github.com/owner/repo/pull/1"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  if [ ! -f "$S/pr" ]; then echo "no pull requests found" >&2; exit 1; fi
  touch "$S/armed"; exit 0
fi
echo "gh stub: unhandled: $*" >&2; exit 1
`;

describe.skipIf(!HAS_GIT)("GitCli gh merge path (stubbed gh)", () => {
  let root: string;
  let repo: string;
  let remote: string;
  let stateDir: string;
  let ghBin: string;
  let card: Card;
  let cli: GitCli;

  beforeAll(async () => {
    root = await mkdtemp(`${tmpdir()}/dev3-loop-gh-`);
    repo = `${root}/repo`;
    remote = `${root}/remote.git`;
    stateDir = `${root}/state`;
    ghBin = `${root}/gh`;
    await mkdir(repo, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(ghBin, GH_STUB);
    await exec("chmod", ["+x", ghBin], { timeoutMs: 5_000 });
    process.env.GH_STUB_STATE = stateDir;

    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "ci@test.local"]);
    await git(repo, ["config", "user.name", "ci"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["checkout", "-q", "-b", "master"]);
    await writeFile(`${repo}/a.txt`, "base\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);

    // A local bare "remote" so maybePush has somewhere fast to push (no network).
    await exec("git", ["init", "-q", "--bare", remote], { timeoutMs: 30_000 });
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "-q", "origin", "master"]);

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(`${repo}/b.txt`, "feature work\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "feature"]);

    cli = new GitCli({ ghBin });
    card = {
      id: "feature0-0000-0000-0000-000000000000",
      repo: "owner/repo",
      baseBranch: "master",
      branch: "feature",
      worktreePath: repo,
      lane: "review-by-user",
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
    delete process.env.GH_STUB_STATE;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("arms auto-merge and returns pending (initiate, not done); the user worktree stays on its branch", async () => {
    expect(await cli.isMerged(card)).toBe(false);

    const r = await cli.merge(card);
    expect(r.merged).toBe(false); // GitHub merges later — initiate only
    expect(r.alreadyMerged).toBe(false);
    expect(r.pending).toBe(true);

    // No local checkout of base: the worktree is still on the feature branch.
    const head = await exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5_000 });
    expect(head.stdout.trim()).toBe("feature");

    // PR opened + auto-merge armed by the stub.
    expect((await exec("test", ["-f", `${stateDir}/pr`], { timeoutMs: 5_000 })).code).toBe(0);
    expect((await exec("test", ["-f", `${stateDir}/armed`], { timeoutMs: 5_000 })).code).toBe(0);
  });

  it("re-polls to alreadyMerged once the remote reflects the merge (exactly-once)", async () => {
    // GitHub's auto-merge fires.
    await writeFile(`${stateDir}/merged`, "");

    expect(await cli.isMerged(card)).toBe(true);
    const r = await cli.merge(card);
    expect(r.merged).toBe(true);
    expect(r.alreadyMerged).toBe(true); // no second merge initiated
  });

  it("isMerged is squash-safe: PR MERGED state wins over a false local ancestry", async () => {
    // A squash merge rewrites SHAs, so the branch is NOT an ancestor of base — raw ancestry would
    // falsely report unmerged and trigger a duplicate merge. The PR-state path must override that.
    const ancestry = await exec(
      "git",
      ["-C", repo, "merge-base", "--is-ancestor", "feature", "master"],
      { timeoutMs: 5_000 },
    );
    expect(ancestry.code).not.toBe(0); // not an ancestor (squash-style)

    // The stub still reports the PR MERGED (the `merged` marker from the previous case).
    expect(await cli.isMerged(card)).toBe(true);
  });
});
