/**
 * The git seam: diff, mechanical checks, and merge/PR. dev-3.0 only does
 * worktree+branch creation; merge and PR are entirely ours (DISCOVERY §Q4-git).
 * "Done" = a merge commit in git, the unfakeable record (PLAN §2 #7).
 *
 * @module ports/git
 */

import type { Card } from "../domain/types.ts";
import type { CheckResult, MergeResult, PrResult } from "./dto.ts";

/**
 * Runs git/checks operations against a card's worktree. All methods are safe to
 * call repeatedly; {@link GitPort.merge} and {@link GitPort.openPr} are guarded for
 * exactly-once via their idempotency flags (PLAN §2 #4, §9).
 */
export interface GitPort {
  /**
   * Compute the card's diff against its base (`base...branch`). Fed to the
   * grader and hashed for oscillation detection (PLAN §8/§10).
   *
   * @param card the card whose worktree/branch to diff.
   * @returns the unified diff text.
   */
  diff(card: Card): Promise<string>;

  /**
   * Run the mechanical checks command in the card's worktree. This — not the
   * producer's self-report — is the source of truth for green/red (PLAN §2 #8).
   *
   * @param card the card whose worktree to run in.
   * @param cmd  the checks command (from `policy.checksCmd`).
   * @returns the structured check outcome.
   */
  runChecks(card: Card, cmd: string): Promise<CheckResult>;

  /**
   * Whether the card's branch is already merged into its base. The idempotency
   * probe for exactly-once merge: on restart, an `intent`-without-`done` is
   * reconciled by checking this, never by blind retry (PLAN §9, §13 test 9).
   *
   * @param card the card to probe.
   * @returns true iff the branch is merged into base.
   */
  isMerged(card: Card): Promise<boolean>;

  /**
   * Merge the card's branch into its base and push. Idempotent — returns
   * `alreadyMerged: true` without re-merging when already merged.
   *
   * @param card the card to merge.
   * @returns the merge outcome (incl. the resulting commit SHA when known).
   */
  merge(card: Card): Promise<MergeResult>;

  /**
   * Open a pull request for the card's branch (the `gh` CLI), for the `open_pr`
   * policy. Idempotent — returns the existing PR with `alreadyExisted: true`
   * when one is already open.
   *
   * @param card the card to open a PR for.
   * @returns the PR outcome (incl. its URL).
   */
  openPr(card: Card): Promise<PrResult>;
}
