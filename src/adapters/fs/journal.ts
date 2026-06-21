// Filesystem JournalPort: durable per-card bookkeeping, one JSON file per card under
// ${stateDir}/journal/<cardId>.json. Atomic writes are the load-bearing invariant — persist
// writes a sibling .json.tmp and renames it over the final path. POSIX rename(2) is atomic, so a
// crash mid-write leaves either the old or the new complete file, never a torn one. Since the
// journal is the single source of truth for loop state, this no-torn-file guarantee is what makes
// crash-recovery correct.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import type { CardJournal } from "../../domain/types.ts";
import type { JournalPort } from "../../ports/journal.ts";

const SUFFIX = ".json";
const TMP_SUFFIX = ".json.tmp"; // staging suffix for the atomic write; never loaded by loadAll

// Construct with the journal directory (typically ${stateDir}/journal); created lazily on first persist.
export class FsJournal implements JournalPort {
  private dirReady = false;

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

  // Create the journal directory once (idempotent; `recursive` makes parents).
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.dir, { recursive: true });
    this.dirReady = true;
  }
}
