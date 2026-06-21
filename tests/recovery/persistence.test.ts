/**
 * Adapter-level tests for the M2 fs persistence seam: `FsJournal` (atomic, one
 * file per card) and `NdjsonEventLog` (append-only, line-parseable). Real fs,
 * throwaway tmpdir.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { FsJournal } from "../../src/adapters/fs/journal.ts";
import { NdjsonEventLog } from "../../src/adapters/fs/eventlog.ts";
import type { CardJournal } from "../../src/domain/types.ts";
import type { LoopEvent } from "../../src/ports/dto.ts";
import { makeStateDir } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await makeStateDir());
});
afterEach(() => cleanup());

function journalOf(cardId: string): CardJournal {
  return { cardId, attempts: [], consecutiveFailures: 0, totalTokens: 0, pending: {} };
}

describe("FsJournal", () => {
  test("loadAll on an absent dir is empty (nothing persisted yet)", async () => {
    const j = new FsJournal(`${dir}/journal`);
    expect(await j.loadAll()).toEqual({});
  });

  test("persist → loadAll round-trips by cardId, one file per card", async () => {
    const j = new FsJournal(`${dir}/journal`);
    await j.persist(journalOf("a"));
    await j.persist(journalOf("b"));

    const loaded = await j.loadAll();
    expect(Object.keys(loaded).sort()).toEqual(["a", "b"]);
    expect(loaded.a!.cardId).toBe("a");

    const files = await readdir(`${dir}/journal`);
    expect(files.sort()).toEqual(["a.json", "b.json"]);
  });

  test("persist overwrites the same card's file (no duplicate)", async () => {
    const j = new FsJournal(`${dir}/journal`);
    await j.persist(journalOf("a"));
    await j.persist({ ...journalOf("a"), totalTokens: 42 });
    const loaded = await j.loadAll();
    expect(Object.keys(loaded)).toEqual(["a"]);
    expect(loaded.a!.totalTokens).toBe(42);
  });

  test("loadAll ignores leftover .json.tmp staging files (interrupted write)", async () => {
    const j = new FsJournal(`${dir}/journal`);
    await j.persist(journalOf("a"));
    // Simulate a crash mid-persist: a stray tmp file the rename never consumed.
    await writeFile(`${dir}/journal/b.json.tmp`, "{ partial");
    const loaded = await j.loadAll();
    expect(Object.keys(loaded)).toEqual(["a"]); // tmp never loaded → no parse error
  });

  test("a written journal is complete JSON on disk (atomic rename, never torn)", async () => {
    const j = new FsJournal(`${dir}/journal`);
    const journal = { ...journalOf("a"), pending: { "a:Merge:1:0": { kind: "Merge", startedAt: 1 } } };
    await j.persist(journal);
    const text = await readFile(`${dir}/journal/a.json`, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toEqual(journal);
  });

  test("a corrupt journal file fails fast and names the path", async () => {
    const j = new FsJournal(`${dir}/journal`);
    await j.persist(journalOf("a"));
    await writeFile(`${dir}/journal/a.json`, "{ not json");
    await expect(j.loadAll()).rejects.toThrow(/a\.json is not valid JSON/);
  });
});

describe("NdjsonEventLog", () => {
  const ev = (over: Partial<LoopEvent> = {}): LoopEvent => ({
    ts: 1_000,
    cardId: "a",
    type: "intent",
    ...over,
  });

  test("read on an absent log is empty", async () => {
    expect(await new NdjsonEventLog(dir).read()).toEqual([]);
  });

  test("append → read preserves order and is one JSON object per line", async () => {
    const log = new NdjsonEventLog(dir);
    await log.append(ev({ type: "intent", action: "Merge", actionId: "x" }));
    await log.append(ev({ type: "done", action: "Merge", actionId: "x" }));

    const events = await log.read();
    expect(events.map((e) => e.type)).toEqual(["intent", "done"]);

    const raw = await readFile(`${dir}/events.ndjson`, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("a corrupt line fails fast and names the line number", async () => {
    const log = new NdjsonEventLog(dir);
    await log.append(ev());
    await writeFile(`${dir}/events.ndjson`, `${JSON.stringify(ev())}\n{ broken\n`, );
    await expect(log.read()).rejects.toThrow(/events\.ndjson:2 is not valid JSON/);
  });
});
