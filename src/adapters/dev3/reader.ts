// The read side of the board seam: lists the project's cards by speaking tasks.list (and
// projects.list, for the project record) over the dev3-server socket, then projecting each task
// to a domain Card via the pure mapper. Read-only — the store is never written here; mutations
// go through Dev3CliBoard. Re-read every tick (the human may have edited the board).

import type { Card, CardPolicy } from "../../domain/types.ts";
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
