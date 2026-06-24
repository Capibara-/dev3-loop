// The out-of-band reviewer: a RuntimePort decorator that runs OUR independent reviewer without
// ever touching dev-3.0's review-by-ai column agent. The card stays in in-progress, so dev-3.0's
// edit-and-commit fixer can never be triggered — double-review is structurally impossible and NO
// per-project config (builtinColumnAgents / autoReviewEnabled) is required.
//
// launchGrader checks the branch HEAD out into a THROWAWAY worktree (true input isolation: the
// reviewer sees only the committed tree + diff, never the implementor's scrollback or
// .dev3/progress.md, and can't touch the implementor's worktree), then fire-and-forgets the
// reviewer agent there. The agent re-runs the checks, diffs origin/<base>, and writes
// .dev3/review.json; readReview polls that file. Everything else delegates to the base runtime.
//
// The reviewer invocation is a configurable command (default `claude -p <rubric>`) so the launch
// mechanism is testable with a deterministic stub and the production agent is a one-line swap.
// // DISCOVERY: the exact headless flags are agent-specific — tune `reviewerCommand` per agent.

import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import type { AgentSpec, Card } from "../../domain/types.ts";
import type { ImplementorResult, Review } from "../../ports/dto.ts";
import type { RuntimePort } from "../../ports/runtime.ts";
import { exec, spawnDetached } from "../exec/index.ts";
import { shortId } from "../dev3/map.ts";

// Returns the binary + argv that runs the reviewer agent headlessly in the worktree (cwd). The
// rubric is the agent's prompt; the agent must write .dev3/review.json relative to cwd.
export type ReviewerCommand = (prompt: string) => { bin: string; args: readonly string[] };

// Default: Claude in print (headless) mode. acceptEdits lets it run the checks + write the
// verdict file; it runs in the throwaway worktree, so edits can't reach the real branch and the
// verdict is re-validated by our own checks regardless (git is truth).
export const DEFAULT_REVIEWER_COMMAND: ReviewerCommand = (prompt) => ({
  bin: "claude",
  args: ["-p", prompt, "--permission-mode", "acceptEdits"],
});

export interface OutOfBandReviewerOptions {
  base: RuntimePort; // delegate non-reviewer methods (typically TmuxRuntime)
  reviewRoot: string; // per-card throwaway worktrees live under here
  reviewerCommand?: ReviewerCommand;
  gitBin?: string; // default "git"
  cloneForReview?: readonly string[]; // gitignored heavy dirs to symlink from the impl worktree
  env?: Record<string, string | undefined>;
  gitTimeoutMs?: number;
}

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export class OutOfBandReviewer implements RuntimePort {
  private readonly base: RuntimePort;
  private readonly reviewRoot: string;
  private readonly command: ReviewerCommand;
  private readonly git: string;
  private readonly cloneForReview: readonly string[];
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly gitTimeoutMs: number;

  constructor(opts: OutOfBandReviewerOptions) {
    this.base = opts.base;
    this.reviewRoot = opts.reviewRoot;
    this.command = opts.reviewerCommand ?? DEFAULT_REVIEWER_COMMAND;
    this.git = opts.gitBin ?? "git";
    this.cloneForReview = opts.cloneForReview ?? ["node_modules"];
    this.env = opts.env;
    this.gitTimeoutMs = opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  // Launch the reviewer in a fresh throwaway worktree at the branch HEAD. Idempotent per launch:
  // it freshens the worktree and clears any prior verdict, so a re-launch (new green attempt)
  // never reads a stale review.json. Fire-and-forget — the tick never blocks on the reviewer.
  async launchGrader(card: Card, _spec: AgentSpec, prompt: string): Promise<void> {
    if (card.worktreePath === null) return; // not started yet — nothing to review
    const wt = this.worktreePath(card);
    await mkdir(this.reviewRoot, { recursive: true });

    // Freshen: drop any prior review worktree (dir + registration), then check the branch HEAD
    // out detached (the branch is checked out in the implementor's worktree, so --detach avoids
    // the "already checked out" error).
    await this.gitRun(card.worktreePath, ["worktree", "remove", "--force", wt]);
    await rm(wt, { recursive: true, force: true });
    await this.gitRun(card.worktreePath, ["worktree", "prune"]);
    const add = await this.gitRun(card.worktreePath, [
      "worktree", "add", "--force", "--detach", wt, card.branch,
    ]);
    if (add.code !== 0) return; // couldn't materialise the worktree — reviewer simply won't run

    // Symlink the gitignored heavy dirs (e.g. node_modules) so the reviewer can actually run the
    // checks; best-effort. A fresh checkout never carries a stale verdict, but clear it anyway.
    for (const dir of this.cloneForReview) {
      try {
        await symlink(`${card.worktreePath}/${dir}`, `${wt}/${dir}`);
      } catch {
        // source absent or already linked — fine
      }
    }
    await mkdir(`${wt}/.dev3`, { recursive: true });
    await rm(`${wt}/.dev3/review.json`, { force: true });

    const { bin, args } = this.command(prompt);
    spawnDetached(bin, args, { cwd: wt, ...(this.env !== undefined ? { env: this.env } : {}) });
  }

  // Verdict written by the reviewer into the throwaway worktree. null until it lands (or if torn).
  async readReview(card: Card): Promise<Review | null> {
    let text: string;
    try {
      text = await readFile(`${this.worktreePath(card)}/.dev3/review.json`, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isReview(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // --- delegated (non-reviewer) RuntimePort surface ---
  launchProducer(card: Card, spec: AgentSpec, prompt: string): Promise<void> {
    return this.base.launchProducer(card, spec, prompt);
  }
  sendFixPrompt(card: Card, text: string): Promise<void> {
    return this.base.sendFixPrompt(card, text);
  }
  capture(card: Card): Promise<string | null> {
    return this.base.capture(card);
  }
  isAlive(card: Card): Promise<boolean> {
    return this.base.isAlive(card);
  }
  readResult(card: Card): Promise<ImplementorResult | null> {
    return this.base.readResult(card);
  }

  private worktreePath(card: Card): string {
    return `${this.reviewRoot}/${shortId(card.id)}`;
  }

  private gitRun(cwd: string, args: readonly string[]): ReturnType<typeof exec> {
    return exec(this.git, args, {
      cwd,
      timeoutMs: this.gitTimeoutMs,
      ...(this.env !== undefined ? { env: this.env } : {}),
    });
  }
}

function isReview(v: unknown): v is Review {
  return (
    typeof v === "object" &&
    v !== null &&
    ((v as Record<string, unknown>).verdict === "pass" ||
      (v as Record<string, unknown>).verdict === "changes_requested")
  );
}
