# Independent reviewer rubric

This is the adversarial, **read-only** rubric the dev3-loop reviewer runs. It is the human-facing
copy of what `src/domain/reviewer.ts` (`buildReviewerPrompt`) generates — the code is the source
of truth; keep this in sync when the rubric changes.

## How it is delivered

The reviewer reuses dev-3.0's `review-by-ai` column agent. Moving a card into `review-by-ai`
(with `autoReviewEnabled`) makes dev-3.0 spawn a fresh agent — **no implementor conversation
inherited**. For that agent to be our read-only reviewer rather than dev-3.0's default
edit-and-commit fixer, the project's `builtinColumnAgents["review-by-ai"]` must be overridden with
our reviewer agent/config + this rubric.

> **There is no CLI/RPC write verb for `builtinColumnAgents`** — it lives in the read-only
> `projects.json` store. The override is an **out-of-band, one-time human/GUI step**. Run
> `reviewerPreflight` (`src/app/preflight.ts`) to detect the double-review hazard before starting.
> `reviewByAiOverride(spec, checksCmd)` produces the exact `{agentId, configId, prompt}` value to install.

## Independence

Independence is by **separate launch + read-only rubric + re-running the checks** (git is the
unfakeable truth), **not** by a distinct model. The reviewer may share the implementor's
`(agent, config)`; a different model is recommended (decorrelated blind spots) but not required,
and nothing asserts they differ.

## The rubric

The reviewer is instructed to:

1. Re-run the mechanical checks itself (never trust `claimedTestsPass`).
2. Diff the branch against `origin/<base>`.
3. Judge the change adversarially against the acceptance criteria (or the full task description).
4. **Not** edit, commit, or move the card — its only output is the verdict file.
5. Write `.dev3/review.json`:

```jsonc
{
  "verdict": "pass" | "changes_requested",
  "criteria": [{ "criterion": "string", "met": true, "note": "string" }],
  "blocking": ["string"],   // empty iff verdict == "pass"
  "ranChecks": true
}
```

The **verdict drives routing, not the board lane** — dev-3.0's on-exit hook may force-advance
`review-by-ai → review-by-user`, but the reconciler reads `review.json` from either lane:
`pass` → human gate (`review-by-user`); `changes_requested` → a fix loops back to the implementor
(folded as a red attempt feeding the failure caps + circuit breaker).
