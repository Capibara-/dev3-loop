/**
 * Filesystem {@link EventLogPort}: the append-only NDJSON spine at
 * `${stateDir}/events.ndjson` (one JSON object per line).
 *
 * This is an **audit/observability trace** that powers `replay` and the
 * operations story — explicitly **not** a source of truth (the journal is). We
 * therefore never read it back into state; the only reader is the `replay`
 * timeline ({@link read}). Appends are write-ahead: `intent` is logged
 * **before** an effectful action runs, `done` **after** it succeeds, correlated by
 * `actionId`.
 *
 * @module adapters/fs/eventlog
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { LoopEvent } from "../../ports/dto.ts";
import type { EventLogPort } from "../../ports/eventlog.ts";

/**
 * Append-only NDJSON event log. Construct with the **state directory**; the log
 * file is `${stateDir}/events.ndjson` and its parent is created lazily on first
 * append.
 */
export class NdjsonEventLog implements EventLogPort {
  /** Full path to the NDJSON file. */
  private readonly path: string;
  /** Whether the state directory has been created this process. */
  private dirReady = false;

  /** @param stateDir the loop state directory (holds `events.ndjson` + `journal/`). */
  constructor(private readonly stateDir: string) {
    this.path = `${stateDir}/events.ndjson`;
  }

  async append(event: LoopEvent): Promise<void> {
    await this.ensureDir();
    // One compact JSON object per line — the NDJSON contract `replay` parses.
    await appendFile(this.path, `${JSON.stringify(event)}\n`);
  }

  /**
   * Read the whole log back as parsed events, in append order. Blank trailing
   * lines are skipped; a malformed line fails fast with its line number (a
   * corrupt audit trace should surface, not be silently truncated). Returns `[]`
   * when the log file does not exist yet.
   */
  async read(): Promise<LoopEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const events: LoopEvent[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as LoopEvent);
      } catch (e) {
        throw new Error(`NdjsonEventLog: ${this.path}:${i + 1} is not valid JSON: ${(e as Error).message}`);
      }
    }
    return events;
  }

  /** Create the state directory once (idempotent). */
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.stateDir, { recursive: true });
    this.dirReady = true;
  }
}
