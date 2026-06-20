/**
 * In-memory {@link GitPort} for tests (PLAN §5/§9/§13). Scriptable diff and
 * checks; {@link FakeGit.merge} flips a per-card "merged" flag exactly once and
 * counts calls, so the exactly-once / write-ahead recovery tests (PLAN §13 #9)
 * can assert a second `merge` is a no-op. No real git.
 *
 * @module adapters/fake/git
 */

import type { Card } from "../../domain/types.ts";
import type { CheckResult, MergeResult, PrResult } from "../../ports/dto.ts";
import type { GitPort } from "../../ports/git.ts";

/** A green {@link CheckResult} used when none is scripted for a card. */
const GREEN: CheckResult = {
  passed: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 0,
};

/**
 * In-memory git. `diff` defaults to `""` and `runChecks` to green; script either
 * per-card with the `set*` helpers. `merge` is idempotent: the first call marks
 * the card merged, every later call returns `alreadyMerged: true`.
 */
export class FakeGit implements GitPort {
  /** card ids passed to `merge`, in order (assert exactly-once: at most one real merge). */
  readonly mergeCalls: string[] = [];
  /** card ids passed to `runChecks`, in order. */
  readonly checkCalls: string[] = [];

  private diffs = new Map<string, string>();
  private checks = new Map<string, CheckResult>();
  private merged = new Set<string>();
  private prs = new Map<string, string>();

  /** Script the diff text returned for a card. */
  setDiff(cardId: string, diff: string): void {
    this.diffs.set(cardId, diff);
  }

  /** Script the checks outcome for a card. */
  setCheckResult(cardId: string, result: CheckResult): void {
    this.checks.set(cardId, result);
  }

  /** Pre-mark a card's branch as already merged (e.g. for recovery fixtures). */
  markMerged(cardId: string): void {
    this.merged.add(cardId);
  }

  diff(card: Card): Promise<string> {
    return Promise.resolve(this.diffs.get(card.id) ?? "");
  }

  runChecks(card: Card, _cmd: string): Promise<CheckResult> {
    this.checkCalls.push(card.id);
    return Promise.resolve(this.checks.get(card.id) ?? GREEN);
  }

  isMerged(card: Card): Promise<boolean> {
    return Promise.resolve(this.merged.has(card.id));
  }

  merge(card: Card): Promise<MergeResult> {
    this.mergeCalls.push(card.id);
    const commit = `merge-${card.id}`;
    if (this.merged.has(card.id)) {
      return Promise.resolve({ merged: true, alreadyMerged: true, commit });
    }
    this.merged.add(card.id);
    return Promise.resolve({ merged: true, alreadyMerged: false, commit });
  }

  openPr(card: Card): Promise<PrResult> {
    const existing = this.prs.get(card.id);
    if (existing !== undefined) {
      return Promise.resolve({ url: existing, alreadyExisted: true });
    }
    const url = `https://example.test/pr/${card.id}`;
    this.prs.set(card.id, url);
    return Promise.resolve({ url, alreadyExisted: false });
  }
}
