/**
 * The board seam: the read-only view of the dev-3.0 store plus the **only**
 * sanctioned mutations (via the `dev3` CLI).
 *
 * @module ports/board
 */

import type { Card, CustomColumnId, Lane } from "../domain/types.ts";

/**
 * Observes and mutates the dev-3.0 board.
 *
 * **Reads** join the split JSON store directly (`~/.dev3.0/projects.json` +
 * `~/.dev3.0/data/<slug>/tasks.json`) — `tasks list` has no real `--json`
 * has no real `--json`. The board JSON is **read-only to us**; every
 * **write** goes through the `dev3` CLI so there is never a second writer to the
 * store.
 */
export interface BoardPort {
  /**
   * Read the current board as domain {@link Card}s (read-only projection of the
   * split JSON store). Re-read every reconcile tick — this is the observed
   * desired state and the human may have edited it (level-triggered).
   *
   * @returns all cards currently on the board.
   */
  listCards(): Promise<Card[]>;

  /**
   * Move a card to a built-in {@link Lane} or a {@link CustomColumnId}, optionally
   * guarded by the lane we believe it is currently in.
   *
   * When `expect` is given the adapter issues a server-enforced compare-and-set
   * (`dev3 task move --status <to> --if-status <expect>`), making the move
   * race-free and idempotent against dev-3.0's own on-exit hooks. The move is a no-op (not an error) when the card is no
   * longer in `expect`.
   *
   * @param id     dev-3.0 task uuid.
   * @param to     destination built-in lane or custom-column id.
   * @param expect lane/column the card is expected to be in for the move to apply.
   */
  moveCard(id: string, to: Lane | CustomColumnId, expect?: Lane | CustomColumnId): Promise<void>;

  /**
   * Attach a human-facing note to a card (`dev3 note add`, `@file` for long
   * bodies). Used to mirror live counters and give-up diagnostics onto the board
   * so the human sees loop progress.
   *
   * @param id   dev-3.0 task uuid.
   * @param note markdown note body.
   */
  addNote(id: string, note: string): Promise<void>;

  /**
   * Set the card's overview (`dev3 overview set`) — the short live status shown
   * on the card. Overwrites any previous overview.
   *
   * @param id   dev-3.0 task uuid.
   * @param text overview text (one short paragraph).
   */
  setOverview(id: string, text: string): Promise<void>;

  /**
   * Optionally subscribe to store changes via `fs.watch` as a **latency
   * optimization only** — correctness still comes from the periodic full
   * reconcile. `onChange` may fire spuriously or be missed; treat it
   * purely as an early wake-up.
   *
   * @param onChange invoked when the store appears to have changed.
   * @returns a disposer that stops watching.
   */
  watch?(onChange: () => void): () => void;
}
