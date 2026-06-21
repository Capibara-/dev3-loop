/**
 * Filesystem {@link JournalPort}: durable per-card bookkeeping, one JSON file per
 * card under `${stateDir}/journal/<cardId>.json`.
 *
 * **Atomic writes are the load-bearing invariant.** `persist` writes a sibling
 * `<cardId>.json.tmp` and then `rename`s it over the final path. POSIX `rename(2)`
 * is atomic, so a crash mid-write leaves either the old complete file or the new
 * complete file — **never a torn one**. The journal is the single source of truth
 * for loop state (the event log is a derived audit trace, never replayed back into
 * state), so this no-torn-file guarantee is what makes crash-recovery correct.
 *
 * @module adapters/fs/journal
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import type { CardJournal } from "../../domain/types.ts";
import type { JournalPort } from "../../ports/journal.ts";

/** `.json` suffix shared by every journal file. */
const SUFFIX = ".json";
/** Staging suffix for the atomic write; never loaded by {@link FsJournal.loadAll}. */
const TMP_SUFFIX = ".json.tmp";

/**
 * On-disk journal. Each card's {@link CardJournal} is one pretty-printed JSON file
 * named by its `cardId`. Construct with the **journal directory** (typically
 * `${stateDir}/journal`); the directory is created lazily on the first `persist`.
 */
export class FsJournal implements JournalPort {
  /** Whether {@link ensureDir} has already created the journal directory this process. */
  private dirReady = false;

  /** @param dir the journal directory, e.g. `${stateDir}/journal`. */
  constructor(private readonly dir: string) {}

  async loadAll(): Promise<Record<string, CardJournal>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      // No directory yet ⇒ nothing has ever been persisted.
      return {};
    }
    const out: Record<string, CardJournal> = {};
    for (const name of names) {
      // Skip the staging files of an interrupted atomic write and any stray entry.
      if (name.endsWith(TMP_SUFFIX) || !name.endsWith(SUFFIX)) continue;
      const path = `${this.dir}/${name}`;
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (e) {
        throw new Error(`FsJournal: cannot read ${path}: ${(e as Error).message}`);
      }
      let journal: CardJournal;
      try {
        journal = JSON.parse(text) as CardJournal;
      } catch (e) {
        // Fail fast and name the file — a corrupt journal must never be silently dropped.
        throw new Error(`FsJournal: ${path} is not valid JSON: ${(e as Error).message}`);
      }
      out[journal.cardId] = journal;
    }
    return out;
  }

  async persist(j: CardJournal): Promise<void> {
    await this.ensureDir();
    const final = `${this.dir}/${j.cardId}${SUFFIX}`;
    const tmp = `${this.dir}/${j.cardId}${TMP_SUFFIX}`;
    // Write the full file to the staging path, then atomically swap it into place.
    await writeFile(tmp, `${JSON.stringify(j, null, 2)}\n`);
    await rename(tmp, final);
  }

  /** Create the journal directory once (idempotent; `recursive` makes parents). */
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.dir, { recursive: true });
    this.dirReady = true;
  }
}
