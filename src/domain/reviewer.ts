// The independent reviewer — PURE: prompt construction + config-hazard detection, no I/O.
// Two concerns:
//  1. The adversarial READ-ONLY rubric the reviewer runs (re-run the checks, diff origin/<base>,
//     judge against the criteria, write .dev3/review.json). Independence is by this separate
//     launch + rubric + re-running checks, NOT by a distinct (agent, config) — the reviewer may
//     share the implementor's model, so nothing here asserts they differ.
//  2. Detecting the double-review hazard: dev-3.0 ships a default review-by-ai column agent that
//     EDITS, COMMITS, and self-moves the card. If that runs instead of our read-only reviewer the
//     two collide, so preflight inspects the effective builtinColumnAgents config (§detect…).

import type { AgentSpec, Card } from "./types.ts";

// Path the reviewer writes its verdict to, inside the worktree. Matches Observation.review.
export const REVIEW_PATH = ".dev3/review.json";

// The built-in column dev-3.0 launches our reviewer in (reusing its column-agent mechanism).
export const REVIEW_BY_AI_COLUMN = "review-by-ai";

// Stable marker embedded in our rubric so detectReviewerHazards can recognise our own reviewer
// config (vs the default fixer) without brittle full-text matching.
const RUBRIC_MARKER = "INDEPENDENT, READ-ONLY reviewer";

// Inputs the rubric is rendered from. `baseBranch` is either a concrete ref (per-card / out-of-band
// launch, e.g. "origin/main") or dev-3.0's literal "{baseBranch}" template token (the per-project
// builtinColumnAgents prompt, which can't bind a per-card ref). `criteria` is the acceptance
// criteria or, lacking them, the full task description.
export interface RubricInputs {
  baseBranch: string;
  checksCmd: string;
  criteria: string;
}

// Render the adversarial read-only reviewer prompt. The reviewer re-runs the checks itself
// (claimedTestsPass is never trusted), reviews the diff, judges against the criteria, and writes
// the structured verdict — and is told NOT to edit, commit, or move the card (our reconciler
// routes off the verdict, not the lane).
export function buildReviewerPrompt(i: RubricInputs): string {
  return [
    `You are an ${RUBRIC_MARKER}. You did NOT write this code; do not trust it.`,
    "",
    "Do NOT edit, fix, or commit anything. Do NOT move the task between columns. Your ONLY",
    `output is the verdict file ${REVIEW_PATH}.`,
    "",
    `1. Re-run the mechanical checks yourself: \`${i.checksCmd}\`. Never trust a claim that they`,
    "   pass — run them and record whether they passed.",
    `2. Review the diff against the base branch: \`git diff ${i.baseBranch}\`.`,
    "3. Judge the change adversarially against the acceptance criteria below — look for bugs,",
    "   unmet criteria, missing edge cases, security issues, and changes unrelated to the task:",
    indent(i.criteria),
    "",
    `Then write ${REVIEW_PATH} as JSON exactly matching this shape (and write nothing else):`,
    "{",
    '  "verdict": "pass" | "changes_requested",',
    '  "criteria": [{ "criterion": "<text>", "met": true, "note": "<why>" }],',
    '  "blocking": ["<must-fix>"],',
    '  "ranChecks": true',
    "}",
    "",
    "Rules:",
    '- verdict is "pass" ONLY if the checks pass AND every acceptance criterion is met.',
    '- Otherwise verdict is "changes_requested" and `blocking` lists each concrete required fix.',
    '- `blocking` is empty if and only if the verdict is "pass".',
    "- `ranChecks` is true only if you actually ran the checks command above.",
    "Write the file even when uncertain; a missing or unparseable file reads as still-reviewing.",
  ].join("\n");
}

// Indent every line of a (possibly multi-line) block by three spaces, for readable embedding.
function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

// Per-card rubric for an out-of-band reviewer launch (and the prompt the shell records on the
// LaunchGrader action). Diffs origin/<base> per the M5 contract.
export function reviewerRubric(card: Card): string {
  const criteria =
    card.acceptanceCriteria.length > 0 ? card.acceptanceCriteria.join("\n") : card.prompt;
  return buildReviewerPrompt({
    baseBranch: `origin/${card.baseBranch}`,
    checksCmd: card.policy.checksCmd,
    criteria,
  });
}

// The per-project builtinColumnAgents["review-by-ai"] override shape (projects.json). agentId is
// the store's "builtin-<name>" form; configId is the model/profile. This is the value a human
// installs out-of-band — there is no CLI/RPC write verb (see task notes).
export interface ReviewByAiAgent {
  agentId: string;
  configId?: string;
  prompt: string;
}

// Build the override from the reviewer AgentSpec + the repo's checks command. Uses dev-3.0's
// "{baseBranch}" token (substituted at launch) since one project-level prompt serves every card.
// No implementor≠reviewer check — independence is by launch+rubric, not by a distinct spec.
export function reviewByAiOverride(spec: AgentSpec, checksCmd: string): ReviewByAiAgent {
  const agent: ReviewByAiAgent = {
    agentId: spec.agent.startsWith("builtin-") ? spec.agent : `builtin-${spec.agent}`,
    prompt: buildReviewerPrompt({
      baseBranch: "origin/{baseBranch}",
      checksCmd,
      criteria: "Read the task description for the acceptance criteria.",
    }),
  };
  if (spec.config !== undefined) agent.configId = spec.config;
  return agent;
}

// --- double-review / autoReview hazard detection --------------------------

// The effective reviewer-relevant project settings (from config.show / projects.list). When
// autoReviewEnabled is true, entering review-by-ai auto-launches the column agent and dev-3.0's
// on-exit hook force-advances review-by-ai → review-by-user; our verdict-driven routing tolerates
// that, but the in-band launch RELIES on it being true.
export interface ReviewerConfigState {
  autoReviewEnabled: boolean;
  reviewByAi: ReviewByAiAgent | null; // effective builtinColumnAgents["review-by-ai"], or null
}

export interface PreflightFinding {
  level: "error" | "warn" | "info";
  message: string;
}

// True iff a configured column-agent prompt is our read-only rubric (vs the default fixer).
function isOurReviewer(agent: ReviewByAiAgent | null): boolean {
  return agent !== null && agent.prompt.includes(RUBRIC_MARKER);
}

// Heuristic: the default dev-3.0 reviewer edits+commits and self-moves the card. Either is fatal
// to read-only independence, so flag a prompt that instructs them.
function looksLikeFixer(agent: ReviewByAiAgent): boolean {
  return /commit|task move|fix directly/i.test(agent.prompt);
}

// Inspect the effective reviewer config against the reviewer we intend to run, returning the
// double-review / mis-configuration hazards a human must resolve out-of-band before the loop runs.
// Pure: the reader supplies `state`; this never does I/O.
export function detectReviewerHazards(
  state: ReviewerConfigState,
  expected: AgentSpec,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  if (!isOurReviewer(state.reviewByAi)) {
    const why =
      state.reviewByAi === null
        ? "no builtinColumnAgents[\"review-by-ai\"] is configured"
        : looksLikeFixer(state.reviewByAi)
          ? "the configured agent EDITS/COMMITS and/or self-moves the card (dev-3.0's default fixer)"
          : "the configured prompt is not our read-only rubric";
    findings.push({
      level: "error",
      message:
        `Double-review hazard: ${why}. Override builtinColumnAgents["review-by-ai"] with the ` +
        `read-only rubric (reviewByAiOverride) so our independent reviewer runs instead.`,
    });
  } else {
    const want = expected.agent.startsWith("builtin-") ? expected.agent : `builtin-${expected.agent}`;
    if (state.reviewByAi!.agentId !== want) {
      findings.push({
        level: "info",
        message:
          `Reviewer agent is ${state.reviewByAi!.agentId}; policy expects ${want}. A different ` +
          `model is fine (recommended even), but confirm it is intentional.`,
      });
    }
  }

  if (!state.autoReviewEnabled) {
    findings.push({
      level: "warn",
      message:
        "autoReviewEnabled is off: moving a card into review-by-ai will NOT auto-launch the " +
        "reviewer in-band. Enable it for the in-band reviewer, or supply an out-of-band reviewer adapter.",
    });
  }

  return findings;
}
