// The read side of the board seam: lists the project's cards by speaking tasks.list (and
// projects.list, for the project record) over the dev3-server socket, then projecting each task
// to a domain Card via the pure mapper. Read-only — the store is never written here; mutations
// go through Dev3CliBoard. Re-read every tick (the human may have edited the board).

import type { Card, CardPolicy } from "../../domain/types.ts";
import type { ReviewByAiAgent, ReviewerConfigState } from "../../domain/reviewer.ts";
import { REVIEW_BY_AI_COLUMN } from "../../domain/reviewer.ts";
import { findSocket, rpc } from "./rpc.ts";
import { taskToCard, type Dev3Project, type Dev3Task } from "./map.ts";

export interface Dev3RpcReaderOptions {
  projectId: string; // the dev-3.0 project this loop manages
  basePolicy: CardPolicy; // repo-default policy overlaid per card (implementor from the store)
  socketPath?: string; // explicit socket (tests); otherwise discovered under dev3Home
  dev3Home?: string; // store root (e.g. ~/.dev3.0); required when socketPath is omitted
  timeoutMs?: number;
}

export class Dev3RpcReader {
  constructor(private readonly opts: Dev3RpcReaderOptions) {}

  async listCards(): Promise<Card[]> {
    const socketPath = await this.socket();
    const project = await this.findProject(socketPath);
    const tasks = (await this.call(socketPath, "tasks.list", {
      projectId: this.opts.projectId,
    })) as Dev3Task[];
    return tasks.map((t) => taskToCard(t, project, this.opts.basePolicy));
  }

  // Effective reviewer-relevant settings for preflight (detectReviewerHazards). // DISCOVERY:
  // config.show{projectId} → {settings:{autoReviewEnabled, builtinColumnAgents:{"review-by-ai":
  // {agentId,configId?,prompt}}}, sources, hasRepoConfig} — the merged global⊕repo values, the
  // authoritative source (a raw projects.list field may be null while the global default differs).
  async reviewerConfig(): Promise<ReviewerConfigState> {
    const socketPath = await this.socket();
    const data = (await this.call(socketPath, "config.show", {
      projectId: this.opts.projectId,
    })) as { settings?: Record<string, unknown> };
    const settings = data.settings ?? {};
    const agents = settings["builtinColumnAgents"];
    const raw =
      agents !== null && typeof agents === "object"
        ? (agents as Record<string, unknown>)[REVIEW_BY_AI_COLUMN]
        : undefined;
    return {
      autoReviewEnabled: settings["autoReviewEnabled"] === true,
      reviewByAi: asReviewByAi(raw),
    };
  }

  private async findProject(socketPath: string): Promise<Dev3Project> {
    const projects = (await this.call(socketPath, "projects.list", {})) as Dev3Project[];
    const project = projects.find((p) => p.id === this.opts.projectId);
    if (project === undefined) {
      throw new Error(`dev3: project ${this.opts.projectId} not found in projects.list`);
    }
    return project;
  }

  private call(socketPath: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.opts.timeoutMs !== undefined
      ? rpc(socketPath, method, params, this.opts.timeoutMs)
      : rpc(socketPath, method, params);
  }

  private socket(): Promise<string> {
    if (this.opts.socketPath !== undefined) return Promise.resolve(this.opts.socketPath);
    if (this.opts.dev3Home === undefined) {
      throw new Error("dev3: Dev3RpcReader needs either socketPath or dev3Home");
    }
    return findSocket(this.opts.dev3Home);
  }
}

// Project the raw builtinColumnAgents["review-by-ai"] record to ReviewByAiAgent, or null when
// absent/malformed (treated by preflight as "no reviewer configured").
function asReviewByAi(raw: unknown): ReviewByAiAgent | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["agentId"] !== "string" || typeof o["prompt"] !== "string") return null;
  const agent: ReviewByAiAgent = { agentId: o["agentId"], prompt: o["prompt"] };
  if (typeof o["configId"] === "string") agent.configId = o["configId"];
  return agent;
}
