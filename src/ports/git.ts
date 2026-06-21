// The git seam: diff, mechanical checks, and merge/PR. dev-3.0 only does worktree+branch
// creation; merge and PR are entirely ours. "Done" = a merge commit in git, the unfakeable
// record. merge/openPr are guarded for exactly-once via their idempotency flags.

import type { Card } from "../domain/types.ts";
import type { CheckResult, MergeResult, PrResult } from "./dto.ts";

export interface GitPort {
  diff(card: Card): Promise<string>; // base...branch; fed to the reviewer and hashed for oscillation
  // Run policy.checksCmd in the worktree — the source of truth for green/red, never self-report.
  runChecks(card: Card, cmd: string): Promise<CheckResult>;
  // The exactly-once merge probe: on restart an intent-without-done is reconciled by checking
  // this, never by blind retry. Must be content/PR-aware (squash safety), not just --is-ancestor.
  isMerged(card: Card): Promise<boolean>;
  merge(card: Card): Promise<MergeResult>; // push + merge; idempotent (alreadyMerged: true when already merged)
  openPr(card: Card): Promise<PrResult>; // `gh` CLI (open_pr policy); idempotent (alreadyExisted: true)
}
