// In-memory GitPort for tests. Scriptable diff and checks; merge flips a per-card "merged" flag
// exactly once and counts calls, so the exactly-once / write-ahead recovery tests can assert a
// second merge is a no-op. No real git.

import type { Card } from "../../domain/types.ts";
import type { CheckResult, MergeResult, PrResult } from "../../ports/dto.ts";
import type { GitPort } from "../../ports/git.ts";

const GREEN: CheckResult = {
  passed: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 0,
};

// diff defaults to "" and runChecks to green; script either per-card with the set* helpers.
// merge is idempotent: the first call marks the card merged, every later one returns alreadyMerged.
export class FakeGit implements GitPort {
  readonly mergeCalls: string[] = []; // assert exactly-once: at most one real merge
  readonly checkCalls: string[] = [];

  private diffs = new Map<string, string>();
  private checks = new Map<string, CheckResult>();
  private merged = new Set<string>();
  private prs = new Map<string, string>();
  private autoPending = new Set<string>();

  setDiff(cardId: string, diff: string): void {
    this.diffs.set(cardId, diff);
  }

  setCheckResult(cardId: string, result: CheckResult): void {
    this.checks.set(cardId, result);
  }

  // Pre-mark a card's branch as already merged (e.g. for recovery fixtures).
  markMerged(cardId: string): void {
    this.merged.add(cardId);
  }

  // Simulate `gh pr merge --auto`: merge() initiates but does NOT complete (returns pending);
  // the branch stays unmerged until completeAutoMerge() flips it (as GitHub would on a later tick).
  armAutoMerge(cardId: string): void {
    this.autoPending.add(cardId);
  }

  completeAutoMerge(cardId: string): void {
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
    // Armed async auto-merge: re-initiating is a safe no-op, never an error — completion lands
    // on a later tick once completeAutoMerge() fires.
    if (this.autoPending.has(card.id)) {
      return Promise.resolve({ merged: false, alreadyMerged: false, pending: true });
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
