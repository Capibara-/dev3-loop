// Pre-run validation. M5 covers the reviewer dimension: before the loop hands cards to the
// in-band reviewer it must confirm the project is configured so OUR read-only reviewer runs —
// not dev-3.0's default edit-and-commit fixer (double-review). The detection is pure
// (detectReviewerHazards); this layer just sources the effective config and formats findings.
// Broader store/config preflight (the full `dev3-loop preflight` command) wires in with the run
// composition (M7).

import type { AgentSpec, ReviewMode } from "../domain/types.ts";
import { detectReviewerHazards, type PreflightFinding } from "../domain/reviewer.ts";

// The slice of the reader preflight needs — kept narrow so it is fakeable in tests without a server.
export interface ReviewerConfigSource {
  reviewerConfig(): Promise<import("../domain/reviewer.ts").ReviewerConfigState>;
}

// Report the reviewer hazards a human must resolve before running. In out-of-band mode the
// double-review hazard is structurally impossible (the loop never enters review-by-ai), so the
// project's builtinColumnAgents/autoReviewEnabled config is irrelevant and there is nothing to
// provision. In in-band mode we read the effective config (no write verb exists — see task
// notes) and flag the collision. `expected` is the reviewer the resolved policy intends to run.
export async function reviewerPreflight(
  source: ReviewerConfigSource,
  expected: AgentSpec,
  reviewMode: ReviewMode,
): Promise<PreflightFinding[]> {
  if (reviewMode === "out-of-band") {
    return [
      {
        level: "info",
        message:
          "Out-of-band review: dev3-loop runs its own reviewer and never enters review-by-ai, " +
          "so no project config is needed and double-review is impossible.",
      },
    ];
  }
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
