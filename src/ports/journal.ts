/**
 * The journal seam: durable per-card bookkeeping. The orchestrator holds no
 * essential state in RAM — counters, attempt history, spend, and write-ahead
 * markers all live here so a crash + restart resumes correctly (PLAN §2 #5, §9).
 *
 * @module ports/journal
 */

import type { CardJournal } from "../domain/types.ts";

/**
 * Persists and loads {@link CardJournal}s (one JSON file per card under
 * `${stateDir}/journal/<cardId>.json`). The journal is a derived projection of
 * the event log and may be rebuilt from it (PLAN §9, §13 test 10).
 */
export interface JournalPort {
  /**
   * Load every card's journal, keyed by `cardId`. Called once per reconcile tick
   * to pair durable bookkeeping with the observed board state.
   *
   * @returns a map of `cardId → CardJournal` (empty map when none exist yet).
   */
  loadAll(): Promise<Record<string, CardJournal>>;

  /**
   * Persist one card's journal with an **atomic** write (write tmp file, then
   * `rename`) so a crash never leaves a torn file (PLAN §9).
   *
   * @param j the journal to write (replaces the prior one for `j.cardId`).
   */
  persist(j: CardJournal): Promise<void>;
}
