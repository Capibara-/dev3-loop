/**
 * In-memory {@link JournalPort} for tests (PLAN §5/§9). Backed by a `Map`;
 * clones on persist and load so a stored journal cannot be mutated through a
 * reference the test still holds (mirrors the real adapter's tmp+rename write).
 *
 * @module adapters/fake/journal
 */

import type { CardJournal } from "../../domain/types.ts";
import type { JournalPort } from "../../ports/journal.ts";

/** Structured deep clone via JSON (CardJournal is plain data — no functions/dates). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** In-memory journal store keyed by `cardId`. */
export class FakeJournal implements JournalPort {
  private store = new Map<string, CardJournal>();

  constructor(initial: CardJournal[] = []) {
    for (const j of initial) this.store.set(j.cardId, clone(j));
  }

  loadAll(): Promise<Record<string, CardJournal>> {
    const out: Record<string, CardJournal> = {};
    for (const [id, j] of this.store) out[id] = clone(j);
    return Promise.resolve(out);
  }

  persist(j: CardJournal): Promise<void> {
    this.store.set(j.cardId, clone(j));
    return Promise.resolve();
  }
}
