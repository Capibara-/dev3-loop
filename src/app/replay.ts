/**
 * `replay`: turn the append-only NDJSON event log into a readable, **read-only**
 * timeline.
 *
 * The event log is an audit/observability trace, **not** a source of truth — so
 * replay reconstructs a *human timeline*, never journal state (PLAN Finding #10).
 * We keep a single `intent`/`done` stream and classify here by `action` kind:
 * a `MoveLane` event is a **lane move**, a `GiveUp` event is a **guardrail trip**,
 * a `Merge`/`OpenPr` event is an irreversible effect. Every `intent` should pair
 * with a `done` by `actionId`; an `intent` with no matching `done` is surfaced as
 * an **unresolved-on-crash** marker (the write-ahead point a crash interrupted).
 *
 * {@link renderTimeline} is pure (events → string); {@link replay} is the thin
 * I/O wrapper that reads the log first.
 *
 * @module app/replay
 */

import type { LoopEvent } from "../ports/dto.ts";
import { NdjsonEventLog } from "../adapters/fs/eventlog.ts";

/** A minimal reader seam so {@link replay} is testable without a real log file. */
export interface EventSource {
  read(): Promise<LoopEvent[]>;
}

/** The outcome of a replay: the parsed events, the rendered timeline, and any orphans. */
export interface ReplayResult {
  /** Every event, in append order. */
  events: LoopEvent[];
  /** The human-readable timeline (also what the CLI prints). */
  timeline: string;
  /** `actionId`s of `intent`s with no matching `done` (interrupted by a crash). */
  unresolved: string[];
}

/** Format one epoch-ms timestamp as an ISO string (stable, sortable). */
declare const Date: { new (ms: number): { toISOString(): string } };
function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * Classify an event's `action` kind into a timeline category. Pure; this is where
 * "lane move" and "guardrail trip" are *derived* (we don't emit dedicated event
 * types — Finding above).
 */
function classify(action: LoopEvent["action"]): string {
  switch (action) {
    case "MoveLane":
      return "lane-move";
    case "GiveUp":
      return "guardrail-trip";
    case "Merge":
    case "OpenPr":
      return "merge/pr";
    case undefined:
      return "event";
    default:
      return "action";
  }
}

/** Render a single line for the `done`/standalone phase of an event. */
function describe(event: LoopEvent): string {
  const tag = classify(event.action);
  const parts: string[] = [`${iso(event.ts)}  ${event.cardId}  ${tag}`];
  if (event.action) parts.push(event.action);
  if (event.detail) {
    const d = event.detail;
    if (typeof d.to === "string") parts.push(`→ ${d.to}${typeof d.expect === "string" ? ` (expect ${d.expect})` : ""}`);
    if (typeof d.reason === "string") parts.push(`reason=${d.reason}`);
    if (d.recovered !== undefined) parts.push(`[recovered:${String(d.recovered)}]`);
  }
  return parts.join("  ");
}

/**
 * Render the timeline from an ordered event list. Pure. Emits one line per
 * `done`/standalone event (an `intent` is the write-ahead prelude to its `done`,
 * so it isn't a separate timeline row), then a trailing section listing any
 * `intent` with no matching `done` as an **unresolved-on-crash** marker.
 */
export function renderTimeline(events: LoopEvent[]): string {
  // Pair intents with dones by actionId to find crash-interrupted effects.
  const doneIds = new Set<string>();
  for (const e of events) if (e.type === "done" && e.actionId) doneIds.add(e.actionId);

  const lines: string[] = [];
  const unresolved: { actionId: string; event: LoopEvent }[] = [];

  for (const e of events) {
    if (e.type === "intent") {
      if (e.actionId && !doneIds.has(e.actionId)) unresolved.push({ actionId: e.actionId, event: e });
      continue; // the matching `done` carries the timeline row
    }
    lines.push(describe(e));
  }

  if (unresolved.length > 0) {
    lines.push("");
    lines.push("unresolved-on-crash (intent with no done — recovery reality-checks these):");
    for (const u of unresolved) {
      lines.push(`  ${iso(u.event.ts)}  ${u.event.cardId}  ${u.event.action ?? "?"}  actionId=${u.actionId}`);
    }
  }

  return lines.join("\n");
}

/** Collect the `actionId`s of unmatched `intent`s (the unresolved markers). */
export function unresolvedActionIds(events: LoopEvent[]): string[] {
  const doneIds = new Set<string>();
  for (const e of events) if (e.type === "done" && e.actionId) doneIds.add(e.actionId);
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "intent" && e.actionId && !doneIds.has(e.actionId)) out.push(e.actionId);
  }
  return out;
}

/** Read the log via an {@link EventSource} and render it. */
export async function replayFrom(source: EventSource): Promise<ReplayResult> {
  const events = await source.read();
  return { events, timeline: renderTimeline(events), unresolved: unresolvedActionIds(events) };
}

/** Read `${stateDir}/events.ndjson` and render its timeline. */
export function replay(stateDir: string): Promise<ReplayResult> {
  return replayFrom(new NdjsonEventLog(stateDir));
}
