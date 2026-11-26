import type { Config } from "./config.js";
import {
  buildMatcher,
  describeExecution,
  executionStart,
  findMatches,
  summarizeExecution,
  type TrimOptions,
} from "./executions.js";
import {
  droppedNodeKeyWarnings,
  N8nApiError,
  N8nClient,
  type ExecutionListQuery,
  type JsonObject,
  type N8nExecution,
  type N8nWorkflow,
} from "./n8nClient.js";
import { applyPatch, validateWorkflow, type PatchOperation } from "./patch.js";
import { AccessBlockedError, assertReadAllowed, assertWriteAllowed, backupWorkflow, isProtected } from "./safety.js";

export interface SearchExecutionsQuery {
  workflowId?: string;
  status?: ExecutionListQuery["status"];
  startedAfter?: string;
  startedBefore?: string;
  text?: string;
  regex?: string;
  nodes?: string[];
  maxResults?: number;
  scanLimit?: number;
  cursor?: string;
}

const SEARCH_PAGE_SIZE = 50;
const MATCHES_PER_EXECUTION = 5;

function parseTime(name: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) throw new Error(`Invalid ${name} "${raw}" (expected an ISO date, e.g. 2026-11-25T14:00:00-03:00)`);
  return time;
}

function workflowIdOf(execution: N8nExecution): string | null {
  return execution.workflowId === undefined || execution.workflowId === null ? null : String(execution.workflowId);
}

export class Tools {
  private readonly client: N8nClient;

  constructor(private readonly config: Config) {
    this.client = new N8nClient(config);
  }

  async listWorkflows(query: {
    name?: string;
    active?: boolean;
    tags?: string;
    projectId?: string;
    limit?: number;
    cursor?: string;
  }) {
    const page = await this.client.listWorkflows(query);
    const visible = this.config.blockProtected
      ? page.data.filter((workflow) => !isProtected(this.config, workflow.name))
      : page.data;
    return {
      nextCursor: page.nextCursor ?? null,
      workflows: visible.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        active: workflow.active ?? false,
        nodeCount: workflow.nodes.length,
        updatedAt: workflow.updatedAt ?? null,
      })),
    };
  }

  async getWorkflow(id: string) {
    const workflow = await this.client.getWorkflow(id);
    assertReadAllowed(this.config, workflow.name);
    return workflow;
  }

  async createWorkflow(workflow: JsonObject, confirmProduction?: boolean) {
    assertWriteAllowed(this.config, String(workflow.name ?? ""), confirmProduction);

    const issues = validateWorkflow(workflow);
    if (issues.length > 0) throw new Error(`Workflow is invalid: ${issues.join("; ")}`);
    return this.client.createWorkflow(workflow);
  }

  async updateWorkflow(
    id: string,
    workflow: JsonObject,
    options: { confirmProduction?: boolean; publishIfActive?: boolean; dryRun?: boolean },
  ) {
    const current = await this.client.getWorkflow(id);
    assertWriteAllowed(this.config, current.name, options.confirmProduction);
    const newName = String(workflow.name ?? "");
    if (newName !== current.name) {
      assertWriteAllowed(this.config, newName, options.confirmProduction);
    }

    const issues = validateWorkflow(workflow);
    if (issues.length > 0) throw new Error(`Workflow is invalid: ${issues.join("; ")}`);
    const warnings = droppedNodeKeyWarnings(workflow);
    if (options.dryRun) return { dryRun: true, warnings, wouldReplace: summarize(current), with: summarize(workflow) };

    const backup = await backupWorkflow(this.config, current);
    const updated = await this.client.updateWorkflow(id, workflow, options.publishIfActive);
    return { backup, warnings, workflow: updated };
  }

  async patchWorkflow(
    id: string,
    operations: PatchOperation[],
    options: { confirmProduction?: boolean; publishIfActive?: boolean; dryRun?: boolean },
  ) {
    const current = await this.client.getWorkflow(id);
    assertWriteAllowed(this.config, current.name, options.confirmProduction);

    const { workflow: patched, warnings: patchWarnings } = applyPatch(current, operations);
    const warnings = [...patchWarnings, ...droppedNodeKeyWarnings(patched)];
    if (patched.name !== current.name) {
      assertWriteAllowed(this.config, patched.name, options.confirmProduction);
    }
    if (options.dryRun) {
      return { dryRun: true, warnings, before: summarize(current), after: summarize(patched) };
    }

    const backup = await backupWorkflow(this.config, current);
    const updated = await this.client.updateWorkflow(id, patched, options.publishIfActive);
    return { backup, warnings, workflow: updated };
  }

  async setActive(id: string, active: boolean, confirmProduction?: boolean) {
    const current = await this.client.getWorkflow(id);
    assertWriteAllowed(this.config, current.name, confirmProduction);
    return active ? this.client.activateWorkflow(id) : this.client.deactivateWorkflow(id);
  }

  async setArchived(id: string, archived: boolean, confirmProduction?: boolean) {
    const current = await this.client.getWorkflow(id);
    assertWriteAllowed(this.config, current.name, confirmProduction);
    return archived ? this.client.archiveWorkflow(id) : this.client.unarchiveWorkflow(id);
  }

  /** Workflow names by id, for one tool call. null means the workflow no longer exists. */
  private nameLookup(): (workflowId: string | null) => Promise<string | null> {
    const cache = new Map<string, Promise<string | null>>();
    return (workflowId) => {
      if (workflowId === null) return Promise.resolve(null);
      let name = cache.get(workflowId);
      if (!name) {
        name = this.client.getWorkflow(workflowId).then(
          (workflow) => workflow.name,
          (error: unknown) => {
            if (error instanceof N8nApiError && (error.status === 404 || error.status === 403)) return null;
            throw error;
          },
        );
        cache.set(workflowId, name);
      }
      return name;
    };
  }

  /** With N8N_BLOCK_PROTECTED, executions of protected workflows (or of workflows that can no longer be checked) are hidden. */
  private visible(workflowName: string | null): boolean {
    if (!this.config.blockProtected) return true;
    return workflowName !== null && !isProtected(this.config, workflowName);
  }

  async listExecutions(query: Omit<ExecutionListQuery, "includeData"> & { errorDetails?: boolean }) {
    const { errorDetails, ...filters } = query;
    const lookup = this.nameLookup();
    if (filters.workflowId) assertReadAllowed(this.config, (await lookup(filters.workflowId)) ?? "");

    const page = await this.client.listExecutions({
      ...filters,
      limit: filters.limit ?? 20,
      includeData: errorDetails ?? filters.status === "error",
    });
    const executions = [];
    for (const execution of page.data) {
      const name = await lookup(workflowIdOf(execution));
      if (this.visible(name)) executions.push(summarizeExecution(execution, name));
    }
    return { nextCursor: page.nextCursor ?? null, executions };
  }

  async getExecution(id: string, options: Partial<TrimOptions> & { nodes?: string[] }) {
    const execution = await this.client.getExecution(id, true);
    const workflowId = workflowIdOf(execution);
    const name = await this.nameLookup()(workflowId);
    if (!this.visible(name)) {
      throw new AccessBlockedError(
        name === null
          ? `Execution ${id}: its workflow ${workflowId ?? "(unknown)"} no longer exists, so N8N_BLOCK_PROTECTED cannot be checked.`
          : `Execution ${id} belongs to "${name}", which is protected and N8N_BLOCK_PROTECTED=true.`,
      );
    }
    const detail = describeExecution(execution, {
      itemsPerOutput: options.itemsPerOutput ?? 3,
      maxStringLength: options.maxStringLength ?? 300,
      nodes: options.nodes,
    });
    return { execution: summarizeExecution(execution, name), ...detail };
  }

  async searchExecutions(query: SearchExecutionsQuery) {
    const matcher = buildMatcher(query.text, query.regex);
    const after = parseTime("startedAfter", query.startedAfter);
    const before = parseTime("startedBefore", query.startedBefore);
    const maxResults = query.maxResults ?? 10;
    const scanLimit = query.scanLimit ?? 300;
    const lookup = this.nameLookup();
    if (query.workflowId) assertReadAllowed(this.config, (await lookup(query.workflowId)) ?? "");

    const results: JsonObject[] = [];
    let scanned = 0;
    let cursor = query.cursor;
    let stoppedBecause: "maxResults" | "scanLimit" | "reachedStartedAfter" | "noMoreExecutions";

    // n8n returns executions newest first and the cursor resumes after the last page read.
    // Whole pages are processed, so the last page can push the results a little past maxResults.
    for (;;) {
      const page = await this.client.listExecutions({
        workflowId: query.workflowId,
        status: query.status,
        includeData: matcher !== null,
        limit: Math.min(SEARCH_PAGE_SIZE, scanLimit - scanned),
        cursor,
      });
      scanned += page.data.length;
      cursor = page.nextCursor ?? undefined;

      let allOlder = after !== null && page.data.length > 0;
      for (const execution of page.data) {
        const start = executionStart(execution);
        if (start === null || after === null || start >= after) allOlder = false;
        if (after !== null && (start === null || start < after)) continue;
        if (before !== null && (start === null || start > before)) continue;

        const matches = matcher ? findMatches(execution, matcher, { nodes: query.nodes, limit: MATCHES_PER_EXECUTION }) : [];
        if (matcher && matches.length === 0) continue;

        const name = await lookup(workflowIdOf(execution));
        if (!this.visible(name)) continue;
        results.push({ ...summarizeExecution(execution, name), matches: matches as unknown as JsonObject[] });
      }

      if (allOlder) {
        stoppedBecause = "reachedStartedAfter";
        cursor = undefined;
        break;
      }
      if (!cursor || page.data.length === 0) {
        stoppedBecause = "noMoreExecutions";
        cursor = undefined;
        break;
      }
      if (results.length >= maxResults) {
        stoppedBecause = "maxResults";
        break;
      }
      if (scanned >= scanLimit) {
        stoppedBecause = "scanLimit";
        break;
      }
    }

    return { scanned, stoppedBecause, nextCursor: cursor ?? null, results };
  }

  async retryExecution(id: string, options: { loadWorkflow?: boolean; confirmProduction?: boolean }) {
    const execution = await this.client.getExecution(id, false);
    const workflowId = workflowIdOf(execution);
    const name = await this.nameLookup()(workflowId);
    if (name === null) {
      throw new Error(`Execution ${id}: workflow ${workflowId ?? "(unknown)"} no longer exists, so it cannot be retried.`);
    }
    assertWriteAllowed(this.config, name, options.confirmProduction);

    const retried = await this.client.retryExecution(id, options.loadWorkflow);
    return { retriedFrom: String(execution.id), execution: summarizeExecution(retried, name) };
  }

  async deleteWorkflow(id: string, confirmProduction?: boolean) {
    const current = await this.client.getWorkflow(id);
    assertWriteAllowed(this.config, current.name, confirmProduction);
    const backup = await backupWorkflow(this.config, current);
    const deleted = await this.client.deleteWorkflow(id);
    return { backup, deleted: { id: deleted.id, name: deleted.name } };
  }
}

function summarize(workflow: JsonObject | N8nWorkflow) {
  const nodes = Array.isArray(workflow.nodes) ? (workflow.nodes as { name: string; type: string }[]) : [];
  return {
    name: workflow.name,
    nodes: nodes.map((node) => `${node.name} (${node.type})`),
    connections: workflow.connections,
    settings: workflow.settings,
  };
}
