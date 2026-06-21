// Startup recovery: reconcile write-ahead `pending` markers left by a crash. Every irreversible
// effect (Merge/OpenPr) persists a journal.pending[actionId] marker before it runs and clears it
// after it succeeds (see loop.ts); a crash between those points leaves a dangling marker. On the
// next boot — before the first tick — recover() walks every journal's pending set and verifies
// reality. Never blind-retry: recovery only reads to decide, and re-initiates nothing itself —
// the level-triggered loop re-derives the work, relying on each effect's idempotency/CAS guard.
//  - Merge  → probe git.isMerged (content/PR-aware). Merged ⇒ the push completed: set
//    terminal:"merged". Not merged ⇒ clear the marker and let the loop re-derive.
//  - OpenPr → clear the marker and re-derive; openPr is idempotent (alreadyExisted), so no
//    reality-check is needed.

import type { Card, CardJournal } from "../domain/types.ts";
import type { BoardPort, EventLogPort, GitPort, JournalPort } from "../ports/index.ts";

// The journal recovery reconciles + the reality it checks against.
export interface RecoverPorts {
  board: BoardPort;
  git: GitPort;
  journal: JournalPort;
  eventLog: EventLogPort;
  clock: { now(): number };
}

export interface RecoveredMarker {
  cardId: string;
  actionId: string;
  kind: string;
  // merged/pr_exists ⇒ the effect had completed; reconciled ⇒ it hadn't (re-derive); orphaned ⇒ no live card.
  resolution: "merged" | "pr_exists" | "reconciled" | "orphaned";
}

export interface RecoveryReport {
  recovered: RecoveredMarker[]; // markers found and resolved (empty ⇒ clean shutdown / nothing in flight)
}

// Reconcile all dangling write-ahead markers. Idempotent: a second run over an already-clean
// journal set is a no-op.
export async function recover(ports: RecoverPorts): Promise<RecoveryReport> {
  const journals = await ports.journal.loadAll();
  const cardsById = await indexCards(ports.board);
  const recovered: RecoveredMarker[] = [];

  for (const cardId of Object.keys(journals)) {
    let journal = journals[cardId]!;
    const actionIds = Object.keys(journal.pending);
    if (actionIds.length === 0) continue;

    const card = cardsById.get(cardId);
    let changed = false;

    for (const actionId of actionIds) {
      const marker = journal.pending[actionId]!;
      const resolved = await resolveMarker(ports, card, journal, marker.kind);
      journal = clearPending(journal, actionId);
      if (resolved.terminal !== undefined) journal = { ...journal, terminal: resolved.terminal };
      changed = true;
      recovered.push({ cardId, actionId, kind: marker.kind, resolution: resolved.resolution });
      // Close the dangling intent in the audit trace so `replay` shows no orphan.
      await ports.eventLog.append({
        ts: ports.clock.now(),
        cardId,
        type: "done",
        action: marker.kind as never,
        actionId,
        detail: { recovered: resolved.resolution },
      });
    }

    if (changed) await ports.journal.persist(journal);
  }

  return { recovered };
}

// Verify reality for one marker; returns how it resolved + any terminal to set.
async function resolveMarker(
  ports: RecoverPorts,
  card: Card | undefined,
  _journal: CardJournal,
  kind: string,
): Promise<{ resolution: RecoveredMarker["resolution"]; terminal?: CardJournal["terminal"] }> {
  // The card is gone from the board (archived/cancelled) — we can't probe git for
  // it; drop the marker so it can't wedge future recovery passes.
  if (card === undefined) return { resolution: "orphaned" };

  if (kind === "Merge") {
    // The one high-stakes, exactly-once effect: probe reality. Merged ⇒ the push
    // completed before the crash, mark terminal so the loop never merges again.
    const merged = await ports.git.isMerged(card);
    return merged ? { resolution: "merged", terminal: "merged" } : { resolution: "reconciled" };
  }
  // OpenPr (and any other marker): recovery does NOT initiate — it only clears the
  // dangling marker and lets the level-triggered loop re-derive. `openPr` is
  // idempotent (`alreadyExisted`), so re-emitting it next tick opens at most one PR.
  return { resolution: "reconciled" };
}

// Build a cardId → Card index (recovery needs the Card to probe git).
async function indexCards(board: BoardPort): Promise<Map<string, Card>> {
  const cards = await board.listCards();
  const map = new Map<string, Card>();
  for (const card of cards) map.set(card.id, card);
  return map;
}

// Clear a resolved marker (new journal; no-op if already gone). Mirrors loop.ts.
function clearPending(journal: CardJournal, actionId: string): CardJournal {
  if (!(actionId in journal.pending)) return journal;
  const pending = { ...journal.pending };
  delete pending[actionId];
  return { ...journal, pending };
}
