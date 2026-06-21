// The board seam: the read-only view of the dev-3.0 store plus the only sanctioned mutations
// (via the `dev3` CLI). Reads join the split JSON store directly (projects.json +
// data/<slug>/tasks.json) — `tasks list` has no real --json. The store is read-only to us;
// every write goes through the CLI so there is never a second writer.

import type { Card, CustomColumnId, Lane } from "../domain/types.ts";

export interface BoardPort {
  // The observed desired state; re-read every tick since the human may have edited it.
  listCards(): Promise<Card[]>;

  // Move to a built-in lane or custom column. When expect is given the adapter issues a
  // server-enforced compare-and-set (--if-status <expect>), making the move race-free against
  // dev-3.0's own on-exit hooks — a no-op (not an error) when the card is no longer in expect.
  moveCard(id: string, to: Lane | CustomColumnId, expect?: Lane | CustomColumnId): Promise<void>;

  addNote(id: string, note: string): Promise<void>; // `dev3 note add` (@file for long bodies); mirrors counters/diagnostics onto the card
  setOverview(id: string, text: string): Promise<void>; // `dev3 overview set` — the short live status on the card

  // Optional fs.watch subscription — a latency optimization only; correctness comes from the
  // periodic full reconcile. May fire spuriously or be missed. Returns a disposer.
  watch?(onChange: () => void): () => void;
}
