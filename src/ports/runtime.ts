// The runtime seam: drives the tmux sessions + worktrees dev-3.0 spawns per card, and reads
// the agents' status files. All pane reads must be timeout-guarded — capture-pane/list-windows
// hang on attached control-mode sessions, so the file signals (readResult/readReview) are the
// authoritative completion source and raw captures are best-effort.

import type { AgentSpec, Card } from "../domain/types.ts";
import type { Review, ImplementorResult } from "./dto.ts";

export interface RuntimePort {
  // Start the implementor in the card's worktree (after promotion to in-progress, once dev-3.0
  // spawned the session). Idempotent: a no-op if it's already running. prompt = the full
  // launch prompt incl. the result.json protocol.
  launchProducer(card: Card, spec: AgentSpec, prompt: string): Promise<void>;

  // Launch the independent reviewer; only after mechanical checks are green. The default adapter
  // moves the card to review-by-ai with builtinColumnAgents overridden to the reviewer config +
  // adversarial rubric. spec may match the implementor's — independence is by launch + rubric +
  // re-running checks, not config.
  launchGrader(card: Card, spec: AgentSpec, prompt: string): Promise<void>;

  // Send fix findings into the implementor's existing pane so it keeps context (red-checks and
  // changes_requested fix loops both).
  sendFixPrompt(card: Card, text: string): Promise<void>;

  capture(card: Card): Promise<string | null>; // best-effort getTerminalPreview RPC (heartbeat delta), timeout-guarded; null if unread
  isAlive(card: Card): Promise<boolean>; // the card's tmux session/pane still exists
  readResult(card: Card): Promise<ImplementorResult | null>; // .dev3/result.json; null if absent/unparseable
  readReview(card: Card): Promise<Review | null>; // .dev3/review.json; null if absent/unparseable
}
