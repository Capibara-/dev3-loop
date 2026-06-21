// Filesystem EventLogPort: the append-only NDJSON trace at ${stateDir}/events.ndjson (one JSON
// object per line). An audit/observability trace that powers `replay` — explicitly NOT a source
// of truth (the journal is), so it's never read back into state; the only reader is the replay
// timeline (read). Appends are write-ahead: intent before an effectful action runs, done after
// it succeeds, correlated by actionId.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { LoopEvent } from "../../ports/dto.ts";
import type { EventLogPort } from "../../ports/eventlog.ts";

// Construct with the state directory; the log file is ${stateDir}/events.ndjson, parent created
// lazily on first append.
export class NdjsonEventLog implements EventLogPort {
  private readonly path: string;
  private dirReady = false;

  constructor(private readonly stateDir: string) {
    this.path = `${stateDir}/events.ndjson`;
  }

  async append(event: LoopEvent): Promise<void> {
    await this.ensureDir();
    await appendFile(this.path, `${JSON.stringify(event)}\n`);
  }

  // Read the whole log back as parsed events, in append order. A malformed line fails fast with
  // its line number (a corrupt audit trace should surface, not be silently truncated). [] when
  // the file does not exist yet.
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

  // Create the state directory once (idempotent).
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.stateDir, { recursive: true });
    this.dirReady = true;
  }
}
