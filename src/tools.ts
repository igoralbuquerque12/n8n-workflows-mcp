import type { Config } from "./config.js";
import { N8nClient, type JsonObject, type N8nWorkflow } from "./n8nClient.js";
import { applyPatch, validateWorkflow, type PatchOperation } from "./patch.js";
import { assertReadAllowed, assertWriteAllowed, backupWorkflow, isProtected } from "./safety.js";

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
    if (options.dryRun) return { dryRun: true, wouldReplace: summarize(current), with: summarize(workflow) };

    const backup = await backupWorkflow(this.config, current);
    const updated = await this.client.updateWorkflow(id, workflow, options.publishIfActive);
    return { backup, workflow: updated };
  }

  async patchWorkflow(
    id: string,
    operations: PatchOperation[],
    options: { confirmProduction?: boolean; publishIfActive?: boolean; dryRun?: boolean },
  ) {
    const current = await this.client.getWorkflow(id);
    assertWriteAllowed(this.config, current.name, options.confirmProduction);

    const { workflow: patched, warnings } = applyPatch(current, operations);
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
