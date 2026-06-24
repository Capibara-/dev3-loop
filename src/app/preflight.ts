// Pre-run validation. M5 covers the reviewer dimension: before the loop hands cards to the
// in-band reviewer it must confirm the project is configured so OUR read-only reviewer runs —
// not dev-3.0's default edit-and-commit fixer (double-review). The detection is pure
// (detectReviewerHazards); this layer just sources the effective config and formats findings.
// Broader store/config preflight (the full `dev3-loop preflight` command) wires in with the run
// composition (M7).

import type { AgentSpec } from "../domain/types.ts";
import { detectReviewerHazards, type PreflightFinding } from "../domain/reviewer.ts";

// The slice of the reader preflight needs — kept narrow so it is fakeable in tests without a server.
export interface ReviewerConfigSource {
  reviewerConfig(): Promise<import("../domain/reviewer.ts").ReviewerConfigState>;
}

// Read the effective reviewer config and report the hazards a human must resolve out-of-band
// (there is no write verb for builtinColumnAgents — see task notes). `expected` is the reviewer
// the resolved policy intends to run.
export async function reviewerPreflight(
  source: ReviewerConfigSource,
  expected: AgentSpec,
): Promise<PreflightFinding[]> {
  const state = await source.reviewerConfig();
  return detectReviewerHazards(state, expected);
}

// True iff any finding is fatal — the caller should refuse to start the in-band reviewer.
export function hasBlockingFinding(findings: readonly PreflightFinding[]): boolean {
  return findings.some((f) => f.level === "error");
}

// One line per finding, prefixed by level, for CLI / log output.
export function formatFindings(findings: readonly PreflightFinding[]): string {
  if (findings.length === 0) return "preflight: reviewer config OK";
  return findings.map((f) => `[${f.level}] ${f.message}`).join("\n");
}
