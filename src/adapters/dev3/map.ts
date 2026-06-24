// Pure projection of the dev-3.0 store records into the domain `Card`. No I/O — the reader
// fetches Dev3Task[]/Dev3Project over the socket and hands them here, and the store-fixture
// test maps the committed sample directly. // DISCOVERY: the field shapes below are the real
// store schema (projects.json + data/<slug>/tasks.json), captured against the live install.

import type { Card, CardPolicy, Lane } from "../../domain/types.ts";

// The subset of a dev-3.0 task record we read. The store carries many more fields (seq,
// history, sessionState, timestamps…) we don't project.
export interface Dev3Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string; // a built-in lane, or a built-in lane alongside a set customColumnId
  baseBranch: string | null;
  worktreePath: string | null; // null until dev-3.0 starts the task
  branchName: string | null; // null until started; deterministic dev3/task-<id8> once set
  agentId: string | null; // implementor agent, e.g. "builtin-claude"
  configId: string | null; // implementor config, e.g. "claude-default-opus48"
  customColumnId: string | null;
}

export interface Dev3Project {
  id: string;
  name: string;
  path: string;
  defaultBaseBranch: string;
}

const BUILTIN_LANES = new Set<Lane>([
  "todo",
  "in-progress",
  "user-questions",
  "review-by-ai",
  "review-by-user",
  "review-by-colleague",
  "completed",
  "cancelled",
]);

// First 8 chars of the uuid — the dev-3.0 worktree/branch/session handle.
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// "builtin-claude" → "claude". // DISCOVERY: store agent ids are "builtin-<name>"; AgentSpec.agent
// is the bare name. Unknown shapes pass through unchanged.
function bareAgent(agentId: string | null): string {
  if (agentId === null) return "";
  return agentId.startsWith("builtin-") ? agentId.slice("builtin-".length) : agentId;
}

// Map one store task to a Card, given its project and the base CardPolicy (repo defaults +
// per-card overrides, resolved by ConfigPort). The implementor spec is the one policy field the
// store actually carries (task.agentId/configId), so it is overlaid here; everything else
// (merge policy, thresholds, reviewer, checksCmd) comes from basePolicy.
export function taskToCard(task: Dev3Task, project: Dev3Project, basePolicy: CardPolicy): Card {
  const lane: Lane = BUILTIN_LANES.has(task.status as Lane) ? (task.status as Lane) : "todo";
  const agent = bareAgent(task.agentId);

  const policy: CardPolicy = {
    ...basePolicy,
    implementor: agent.length > 0 ? withConfig(agent, task.configId) : basePolicy.implementor,
  };

  return {
    id: task.id,
    repo: project.name, // DISCOVERY: no owner/name in the store; project.name is the handle
    baseBranch: task.baseBranch ?? project.defaultBaseBranch,
    branch: task.branchName ?? `dev3/task-${shortId(task.id)}`,
    worktreePath: task.worktreePath,
    lane,
    customColumnId: task.customColumnId,
    prompt: task.description, // DISCOVERY: no structured acceptance-criteria field; reviewer uses the prompt
    acceptanceCriteria: [],
    policy,
  };
}

function withConfig(agent: string, config: string | null): CardPolicy["implementor"] {
  return config !== null && config.length > 0 ? { agent, config } : { agent };
}
