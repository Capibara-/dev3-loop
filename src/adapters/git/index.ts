// GitPort over the real `git` (and `gh`) CLIs. git is the unfakeable record of "done": a merge
// commit on the base branch is the truth, never an agent's self-report. The exactly-once /
// write-ahead machinery in the loop leans on isMerged being content-aware (squash-safe), so it
// asks `gh` for the PR's merge state first and only falls back to local ancestry. All commands
// run in the card's worktree and are timeout-guarded via the exec seam.

import { tmpdir } from "node:os";

import type { Card } from "../../domain/types.ts";
import type { CheckResult, MergeResult, PrResult } from "../../ports/dto.ts";
import type { GitPort } from "../../ports/git.ts";
import { exec, type ExecResult } from "../exec/index.ts";

declare const Date: { now(): number };

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_CHECKS_TIMEOUT_MS = 600_000; // checks can be a full test suite

export type MergeStrategy = "merge" | "squash" | "rebase";

export interface GitCliOptions {
  gitBin?: string; // default "git"
  ghBin?: string; // default "gh"
  shell?: string; // shell for runChecks; default "bash"
  gitTimeoutMs?: number;
  checksTimeoutMs?: number;
  mergeStrategy?: MergeStrategy; // `gh pr merge` strategy; default "merge"
}

export class GitCli implements GitPort {
  private readonly git: string;
  private readonly gh: string;
  private readonly shell: string;
  private readonly gitTimeoutMs: number;
  private readonly checksTimeoutMs: number;
  private readonly mergeStrategy: MergeStrategy;

  constructor(opts: GitCliOptions = {}) {
    this.git = opts.gitBin ?? "git";
    this.gh = opts.ghBin ?? "gh";
    this.shell = opts.shell ?? "bash";
    this.gitTimeoutMs = opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.checksTimeoutMs = opts.checksTimeoutMs ?? DEFAULT_CHECKS_TIMEOUT_MS;
    this.mergeStrategy = opts.mergeStrategy ?? "merge";
  }

  // base...branch: the changes introduced on the branch since it diverged from base — what the
  // reviewer sees and what the oscillation hash is taken over. // DISCOVERY: against a real
  // dev-3.0 checkout base is typically origin/<base>; left to config to qualify the ref.
  async diff(card: Card): Promise<string> {
    const r = await this.run(card, ["diff", `${card.baseBranch}...${card.branch}`]);
    return r.stdout;
  }

  // Run the policy's checks command in the worktree. exitCode 0 ⇒ green; this is the sole
  // source of truth. failingTests parsing is best-effort and command-specific, so it is left
  // unset here (the domain's no-progress signature simply has less to hash).
  async runChecks(card: Card, cmd: string): Promise<CheckResult> {
    const cwd = this.worktree(card);
    const start = Date.now();
    const r = await exec(this.shell, ["-c", cmd], { cwd, timeoutMs: this.checksTimeoutMs });
    return {
      passed: r.code === 0 && !r.timedOut,
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: Date.now() - start,
    };
  }

  // Content/PR-aware merge probe. Prefer the PR's own state (squash merges leave no ancestry),
  // and fall back to local ancestry when `gh`/the PR is unavailable (e.g. a local-only repo).
  async isMerged(card: Card): Promise<boolean> {
    const viaPr = await this.prMerged(card);
    if (viaPr !== null) return viaPr;
    const r = await this.run(card, ["merge-base", "--is-ancestor", card.branch, card.baseBranch]);
    return r.code === 0;
  }

  // Idempotent, exactly-once merge. If the branch is already merged we report alreadyMerged and
  // do nothing irreversible (the guard the write-ahead recovery relies on). DEFAULT path =
  // push + `gh pr merge --auto`: GitHub merges server-side, so the user's worktree is never
  // checked out onto base. Auto-merge completes ASYNCHRONOUSLY (GitHub gates on its own required
  // checks), so a freshly-armed merge returns `pending` — the level-triggered loop re-polls
  // isMerged and only then records terminal. Non-GitHub repos fall back to a local merge in a
  // THROWAWAY worktree (never the card's), so the branch-checked-out-once rule still can't bite.
  async merge(card: Card): Promise<MergeResult> {
    if (await this.isMerged(card)) {
      return { merged: true, alreadyMerged: true, commit: await this.revParse(card, card.baseBranch) };
    }
    await this.maybePush(card);
    if (await this.githubCapable(card)) return this.mergeViaGh(card);
    return this.mergeLocally(card);
  }

  // Open a PR via `gh` (idempotent: report the existing PR if one is already open for the
  // branch). Not exercised by the local-repo integration test; the merge path is the tested one.
  async openPr(card: Card): Promise<PrResult> {
    const existing = await this.prUrl(card);
    if (existing !== null) return { url: existing, alreadyExisted: true };
    const r = await this.ghRun(card, [
      "pr",
      "create",
      "--base",
      card.baseBranch,
      "--head",
      card.branch,
      "--fill",
    ]);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${msg(r)}`);
    return { url: r.stdout.trim(), alreadyExisted: false };
  }

  // ---- internals ----

  // GitHub path viable iff `gh` resolves this worktree to a repo it is authed for. A local-only
  // or non-GitHub repo (no resolvable remote) fails here and falls back to a local merge.
  private async githubCapable(card: Card): Promise<boolean> {
    const r = await this.ghRun(card, ["repo", "view", "--json", "url"]);
    return r.code === 0;
  }

  // Server-side merge: ensure a PR exists, then arm auto-merge. No local base checkout. Auto-merge
  // is async, so a successful arm that hasn't merged yet is `pending` (re-poll), not a failure. A
  // repo with auto-merge disabled falls through to an immediate `gh pr merge`. Re-arming an
  // already-armed merge is a safe no-op, so re-emitting Merge on a later tick is idempotent.
  private async mergeViaGh(card: Card): Promise<MergeResult> {
    const pr = await this.ensurePr(card);
    if (pr !== null) return { merged: false, alreadyMerged: false, message: pr };

    let r = await this.ghMerge(card, true);
    if (r.code !== 0 && !(await this.isMerged(card))) r = await this.ghMerge(card, false);

    if (await this.isMerged(card)) {
      return { merged: true, alreadyMerged: false, commit: await this.revParse(card, card.baseBranch) };
    }
    if (r.code === 0) return { merged: false, alreadyMerged: false, pending: true }; // armed, awaiting checks
    return { merged: false, alreadyMerged: false, message: msg(r) };
  }

  // Local fallback for repos `gh pr merge` can't serve. NEVER checks base out in the card's
  // worktree — uses a throwaway linked worktree at base, merges --no-ff there, pushes base if a
  // remote exists, and always removes the worktree.
  private async mergeLocally(card: Card): Promise<MergeResult> {
    const wt = `${tmpdir()}/dev3-loop-merge-${card.id.slice(0, 8)}-${Date.now()}`;
    const add = await this.run(card, ["worktree", "add", wt, card.baseBranch]);
    if (add.code !== 0) return { merged: false, alreadyMerged: false, message: msg(add) };
    try {
      const m = await this.runIn(wt, [
        "merge",
        "--no-ff",
        "-m",
        `Merge ${card.branch} into ${card.baseBranch}`,
        card.branch,
      ]);
      if (m.code !== 0) return { merged: false, alreadyMerged: false, message: msg(m) };
      const commit = (await this.runIn(wt, ["rev-parse", "HEAD"])).stdout.trim();
      const remote = await this.run(card, ["remote"]);
      if (remote.code === 0 && remote.stdout.trim().length > 0) {
        await this.runIn(wt, ["push", "origin", card.baseBranch]);
      }
      return { merged: true, alreadyMerged: false, commit };
    } finally {
      await this.run(card, ["worktree", "remove", "--force", wt]);
    }
  }

  // Ensure an open PR for the branch (gh pr merge needs one). Idempotent. Returns null on success,
  // or an error message when creation failed.
  private async ensurePr(card: Card): Promise<string | null> {
    if ((await this.prUrl(card)) !== null) return null;
    const r = await this.ghRun(card, ["pr", "create", "--base", card.baseBranch, "--head", card.branch, "--fill"]);
    return r.code === 0 ? null : `gh pr create failed: ${msg(r)}`;
  }

  private ghMerge(card: Card, auto: boolean): Promise<ExecResult> {
    const args = ["pr", "merge", card.branch, ...(auto ? ["--auto"] : []), `--${this.mergeStrategy}`];
    return this.ghRun(card, args);
  }

  private async maybePush(card: Card): Promise<void> {
    const hasRemote = await this.run(card, ["remote"]);
    if (hasRemote.code === 0 && hasRemote.stdout.trim().length > 0) {
      await this.run(card, ["push", "origin", card.branch]);
    }
  }

  private async revParse(card: Card, ref: string): Promise<string> {
    const r = await this.run(card, ["rev-parse", ref]);
    return r.stdout.trim();
  }

  // PR merge state via gh: true iff MERGED, false for an existing-but-unmerged PR, null when gh
  // is unavailable or there is no PR (caller falls back to ancestry).
  private async prMerged(card: Card): Promise<boolean | null> {
    const r = await this.ghRun(card, ["pr", "view", card.branch, "--json", "state"]);
    if (r.code !== 0) return null;
    try {
      const state = (JSON.parse(r.stdout) as { state?: string }).state;
      if (state === undefined) return null;
      return state === "MERGED";
    } catch {
      return null;
    }
  }

  private async prUrl(card: Card): Promise<string | null> {
    const r = await this.ghRun(card, ["pr", "view", card.branch, "--json", "url"]);
    if (r.code !== 0) return null;
    try {
      return (JSON.parse(r.stdout) as { url?: string }).url ?? null;
    } catch {
      return null;
    }
  }

  private worktree(card: Card): string {
    if (card.worktreePath === null) throw new Error(`git: card ${card.id} has no worktree yet`);
    return card.worktreePath;
  }

  private run(card: Card, args: readonly string[]): Promise<ExecResult> {
    return exec(this.git, ["-C", this.worktree(card), ...args], { timeoutMs: this.gitTimeoutMs });
  }

  // git in an arbitrary directory (the throwaway merge worktree), not the card's.
  private runIn(dir: string, args: readonly string[]): Promise<ExecResult> {
    return exec(this.git, ["-C", dir, ...args], { timeoutMs: this.gitTimeoutMs });
  }

  private ghRun(card: Card, args: readonly string[]): Promise<ExecResult> {
    return exec(this.gh, args, { cwd: this.worktree(card), timeoutMs: this.gitTimeoutMs });
  }
}

function msg(r: ExecResult): string {
  return (r.stderr || r.stdout).trim();
}
