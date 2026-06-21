// In-memory BoardPort for tests. Holds the cards in RAM and records every mutation so unit
// tests can assert the reconciler's intent without a running dev-3.0 or real I/O. The moveCard
// expect guard mirrors dev-3.0's server-enforced compare-and-set (--if-status): when expect is
// given and the card is no longer in that lane the move is a no-op, not an error.

import type { Card, CustomColumnId, Lane } from "../../domain/types.ts";
import type { BoardPort } from "../../ports/board.ts";

const BUILTIN_LANES = new Set<string>([
  "todo",
  "in-progress",
  "user-questions",
  "review-by-ai",
  "review-by-user",
  "review-by-colleague",
  "completed",
  "cancelled",
]);

export interface MoveRecord {
  id: string;
  to: Lane | CustomColumnId;
  expect: Lane | CustomColumnId | undefined; // compare-and-set guard, or undefined for unguarded
  applied: boolean; // false when the expect guard did not match and the move was skipped
}

export interface NoteRecord {
  id: string;
  note: string;
}

export interface OverviewRecord {
  id: string;
  text: string;
}

// Construct with the cards under test; mutations update the in-memory cards (so listCards
// reflects moves) and append to the public record arrays for assertions.
export class FakeBoard implements BoardPort {
  readonly cards: Card[]; // live cards, mutated in place by moveCard
  readonly moves: MoveRecord[] = []; // every moveCard call (incl. guard-skipped ones)
  readonly notes: NoteRecord[] = [];
  readonly overviews: OverviewRecord[] = [];

  private watchers = new Set<() => void>();

  constructor(cards: Card[] = []) {
    this.cards = cards;
  }

  listCards(): Promise<Card[]> {
    return Promise.resolve([...this.cards]);
  }

  moveCard(id: string, to: Lane | CustomColumnId, expect?: Lane | CustomColumnId): Promise<void> {
    const card = this.cards.find((c) => c.id === id);
    const applied = card !== undefined && (expect === undefined || card.lane === expect);
    this.moves.push({ id, to, expect, applied });
    if (applied && card) {
      if (BUILTIN_LANES.has(to)) {
        card.lane = to as Lane;
        card.customColumnId = null;
      } else {
        card.customColumnId = to;
      }
    }
    return Promise.resolve();
  }

  addNote(id: string, note: string): Promise<void> {
    this.notes.push({ id, note });
    return Promise.resolve();
  }

  setOverview(id: string, text: string): Promise<void> {
    this.overviews.push({ id, text });
    return Promise.resolve();
  }

  watch(onChange: () => void): () => void {
    this.watchers.add(onChange);
    return () => this.watchers.delete(onChange);
  }

  // Test helper: fire all registered `watch` callbacks (simulate a store change).
  emitChange(): void {
    for (const w of this.watchers) w();
  }
}
