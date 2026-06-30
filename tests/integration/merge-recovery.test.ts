// Recovery test 9 against REAL git (opt-in: DEV3_LOOP_MERGE_IT=1). The fakes-based version lives
// in tests/recovery; this one proves exactly-once against an actual repo: a crash leaves a Merge
// `pending` marker after the branch was already merged in git, restart runs recover() which probes
// the real isMerged → marks terminal:"merged" WITHOUT re-merging, and a subsequent reconcile tick
// leaves the base branch's merge commit untouched (no second merge).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createLoop } from "../../src/app/loop.ts";
import { recover } from "../../src/app/recover.ts";
import { GitCli } from "../../src/adapters/git/index.ts";
import { FakeBoard, FakeConfig, FakeRuntime, FixedClock } from "../../src/adapters/fake/index.ts";
import { FsJournal } from "../../src/adapters/fs/journal.ts";
import { NdjsonEventLog } from "../../src/adapters/fs/eventlog.ts";
import { exec } from "../../src/adapters/exec/index.ts";
import type { Card, CardJournal, CardPolicy } from "../../src/domain/types.ts";
import type { LoopPorts } from "../../src/app/loop.ts";

declare const process: { env: Record<string, string | undefined> };

const RUN = process.env.DEV3_LOOP_MERGE_IT === "1";
const HAS_GIT = (await exec("git", ["--version"], { timeoutMs: 5_000 })).code === 0;

async function git(dir: string, args: readonly string[]): Promise<string> {
  const r = await exec("git", ["-C", dir, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} → ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const MERGE_COL = "ready_to_merge";

function policy(): CardPolicy {
  return {
    merge: "merge_when_green",
    maxConsecutiveFailures: 3,
    maxTotalAttempts: 6,
    stallMs: 600_000,
    implementor: { agent: "claude" },
    reviewer: { agent: "gemini" },
    checksCmd: "true",
  };
}

describe.skipIf(!RUN || !HAS_GIT)("exactly-once merge recovery (real git)", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(`${tmpdir()}/dev3-loop-mrec-`);
    repo = `${root}/repo`;
    await exec("git", ["init", "-q", repo], { timeoutMs: 30_000 });
    await git(repo, ["config", "user.email", "ci@test.local"]);
    await git(repo, ["config", "user.name", "ci"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["checkout", "-q", "-b", "master"]);
    await writeFile(`${repo}/a.txt`, "base\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(`${repo}/b.txt`, "work\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "feature"]);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  it("crash after a real merge ⇒ recover marks merged ⇒ no second merge", async () => {
    const card: Card = {
      id: "feat0000-0000-0000-0000-000000000000",
      repo: "owner/repo",
      baseBranch: "master",
      branch: "feature",
      worktreePath: repo,
      lane: "review-by-user",
      customColumnId: MERGE_COL,
      prompt: "x",
      acceptanceCriteria: [],
      policy: policy(),
    };

    // The merge actually happened before the crash (no remote/gh ⇒ local throwaway-worktree merge).
    const git0 = new GitCli();
    const merged = await git0.merge(card);
    expect(merged.merged).toBe(true);
    expect(await git0.isMerged(card)).toBe(true);
    const baseAfterMerge = await git(repo, ["rev-parse", "master"]);

    // ...but the process died before persisting `done` / clearing the marker.
    const stateDir = `${root}/state`;
    const journal = new FsJournal(`${stateDir}/journal`);
    const eventLog = new NdjsonEventLog(stateDir);
    const actionId = `${card.id}:Merge:1:0`;
    const crashed: CardJournal = {
      cardId: card.id,
      attempts: [{ n: 1, outcome: "green", startedAt: 1, endedAt: 1 }],
      consecutiveFailures: 0,
      totalTokens: 0,
      pending: { [actionId]: { kind: "Merge", startedAt: 1 } },
    };
    await journal.persist(crashed);
    await eventLog.append({ ts: 1, cardId: card.id, type: "intent", action: "Merge", actionId });

    // Restart: fresh ports over the same disk + the same real repo.
    const ports: LoopPorts = {
      board: new FakeBoard([card]),
      runtime: new FakeRuntime(),
      git: new GitCli(),
      journal,
      eventLog,
      clock: new FixedClock(2),
      config: new FakeConfig(card.policy),
    };

    const report = await recover(ports);
    expect(report.recovered).toEqual([
      { cardId: card.id, actionId, kind: "Merge", resolution: "merged" },
    ]);
    const afterRecover = (await journal.loadAll())[card.id]!;
    expect(afterRecover.terminal).toBe("merged");
    expect(afterRecover.pending).toEqual({});

    // A subsequent reconcile must NOT merge again: base is unchanged.
    const loop = createLoop(ports, { concurrencyCap: 10 });
    await loop.tick();
    expect(await git(repo, ["rev-parse", "master"])).toBe(baseAfterMerge);
    expect((await journal.loadAll())[card.id]!.terminal).toBe("merged");
  });
});
