# Independent reviewer rubric

This is the adversarial, **read-only** rubric the dev3-loop reviewer runs. It is the human-facing
copy of what `src/domain/reviewer.ts` (`buildReviewerPrompt`) generates — the code is the source
of truth; keep this in sync when the rubric changes.

## How it is delivered

Two modes, selected by `reviewMode` (`src/domain/types.ts`):

**`out-of-band` (default).** dev3-loop spawns its own reviewer — a fresh headless agent
(default `claude -p <rubric>`) in a **throwaway git worktree at the branch HEAD**
(`OutOfBandReviewer`, `src/adapters/review/out-of-band.ts`). The card **never enters
`review-by-ai`**, so dev-3.0's column agent can't be triggered: **double-review is structurally
impossible and no project config is required.** The reviewer writes `.dev3/review.json` into the
throwaway worktree; the reconciler polls it and routes `in-progress → review-by-user` on `pass`,
or loops a fix back on `changes_requested`. True input isolation: the reviewer sees only the
committed tree + diff, never the implementor's scrollback or `.dev3/progress.md`.

**`in-band` (opt-in).** Reuse dev-3.0's `review-by-ai` column agent: moving a card there (with
`autoReviewEnabled`) makes dev-3.0 spawn a fresh agent. For it to be our read-only reviewer rather
than dev-3.0's default edit-and-commit fixer, the project's `builtinColumnAgents["review-by-ai"]`
must be overridden with our reviewer agent/config + this rubric.

> **There is no CLI/RPC write verb for `builtinColumnAgents`** — it lives in the read-only
> `projects.json` store. The in-band override is therefore an **out-of-band, one-time human/GUI
> step**. Run `reviewerPreflight` (`src/app/preflight.ts`) to detect the double-review hazard
> before starting; `reviewByAiOverride(spec, checksCmd)` produces the exact
> `{agentId, configId, prompt}` value to install. The `out-of-band` default avoids all of this.

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

The **verdict drives routing, not the board lane**: `pass` → human gate (`review-by-user`);
`changes_requested` → a fix loops back to the implementor (folded as a red attempt feeding the
failure caps + circuit breaker). In `out-of-band` mode the card sits in `in-progress` throughout
and moves straight to `review-by-user` on pass. In `in-band` mode the reconciler reads
`review.json` from either review lane, since dev-3.0's on-exit hook may force-advance
`review-by-ai → review-by-user` before we read it.
