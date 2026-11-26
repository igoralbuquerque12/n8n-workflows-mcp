#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import type { JsonObject } from "./n8nClient.js";
import type { PatchOperation } from "./patch.js";
import { Tools } from "./tools.js";

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const tools = new Tools(config);
const server = new McpServer({ name: "n8n-workflows", version: "0.1.0" });

const confirmProduction = z
  .boolean()
  .optional()
  .describe("Set to true only after the user approved this exact change. Required when N8N_ACCESS=confirm or the workflow name is protected. It cannot unlock workflows blocked by N8N_BLOCK_PROTECTED.");
const publishIfActive = z
  .boolean()
  .optional()
  .describe("false saves a draft without republishing a published workflow (default: republish)");
const dryRun = z.boolean().optional().describe("Validate and show the result without writing anything");
const workflowId = z.string().describe("Workflow ID");
const jsonObject = z.record(z.string(), z.unknown());

async function respond(action: () => Promise<unknown> | unknown) {
  try {
    const result = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

server.registerTool(
  "n8n_list_workflows",
  {
    description: "List workflows (id, name, active, node count). Use the returned id with the other tools.",
    inputSchema: {
      name: z.string().optional().describe("Filter by exact workflow name"),
      active: z.boolean().optional(),
      tags: z.string().optional().describe("Comma-separated tag names"),
      projectId: z.string().optional(),
      limit: z.number().int().min(1).max(250).optional(),
      cursor: z.string().optional().describe("nextCursor from the previous page"),
    },
    annotations: { readOnlyHint: true },
  },
  (query) => respond(() => tools.listWorkflows(query)),
);

server.registerTool(
  "n8n_get_workflow",
  {
    description: "Get the full workflow JSON (nodes, connections, settings).",
    inputSchema: { id: workflowId },
    annotations: { readOnlyHint: true },
  },
  ({ id }) => respond(() => tools.getWorkflow(id)),
);

server.registerTool(
  "n8n_create_workflow",
  {
    description:
      "Create a workflow. Requires name, nodes, connections and settings (use {} for empty settings). New workflows are created inactive.",
    inputSchema: { workflow: jsonObject.describe("Workflow JSON"), confirmProduction },
    annotations: { destructiveHint: false },
  },
  ({ workflow, confirmProduction: confirmed }) =>
    respond(() => tools.createWorkflow(workflow as JsonObject, confirmed)),
);

server.registerTool(
  "n8n_update_workflow",
  {
    description:
      "Replace a workflow with the given JSON (name, nodes, connections and settings are all required). Prefer n8n_patch_workflow for small changes. The previous version is backed up when a backup directory is configured.",
    inputSchema: {
      id: workflowId,
      workflow: jsonObject.describe("Complete workflow JSON"),
      confirmProduction,
      publishIfActive,
      dryRun,
    },
    annotations: { destructiveHint: true },
  },
  ({ id, workflow, ...options }) =>
    respond(() => tools.updateWorkflow(id, workflow as JsonObject, options)),
);

const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setName"), name: z.string() }),
  z.object({ op: z.literal("mergeSettings"), settings: jsonObject }),
  z.object({ op: z.literal("addNode"), node: jsonObject.describe("Node with name, type, typeVersion, position, parameters") }),
  z.object({
    op: z.literal("updateNode"),
    name: z.string(),
    changes: jsonObject.describe("parameters are deep-merged (null removes a key); other fields replace the existing value"),
  }),
  z.object({ op: z.literal("removeNode"), name: z.string() }),
  z.object({ op: z.literal("renameNode"), from: z.string(), to: z.string() }),
  z.object({
    op: z.literal("connect"),
    from: z.string(),
    to: z.string(),
    type: z.string().optional().describe("Connection type, default main (use ai_* for AI sub-nodes)"),
    fromIndex: z.number().int().min(0).optional().describe("Output index of the source node"),
    toIndex: z.number().int().min(0).optional().describe("Input index of the target node"),
  }),
  z.object({
    op: z.literal("disconnect"),
    from: z.string(),
    to: z.string(),
    type: z.string().optional(),
    fromIndex: z.number().int().min(0).optional(),
  }),
]);

server.registerTool(
  "n8n_patch_workflow",
  {
    description:
      "Edit a workflow with a list of operations (setName, mergeSettings, addNode, updateNode, removeNode, renameNode, connect, disconnect). Fetches the current version, applies the operations in order, validates node names and connections, then saves. Nothing is written if any operation fails.",
    inputSchema: {
      id: workflowId,
      operations: z.array(operationSchema).min(1),
      confirmProduction,
      publishIfActive,
      dryRun,
    },
    annotations: { destructiveHint: true },
  },
  ({ id, operations, ...options }) =>
    respond(() => tools.patchWorkflow(id, operations as PatchOperation[], options)),
);

server.registerTool(
  "n8n_set_workflow_active",
  {
    description: "Activate (publish) or deactivate a workflow.",
    inputSchema: { id: workflowId, active: z.boolean(), confirmProduction },
    annotations: { destructiveHint: true },
  },
  ({ id, active, confirmProduction: confirmed }) =>
    respond(() => tools.setActive(id, active, confirmed)),
);

server.registerTool(
  "n8n_set_workflow_archived",
  {
    description: "Archive or unarchive a workflow.",
    inputSchema: { id: workflowId, archived: z.boolean(), confirmProduction },
    annotations: { destructiveHint: true },
  },
  ({ id, archived, confirmProduction: confirmed }) =>
    respond(() => tools.setArchived(id, archived, confirmed)),
);

server.registerTool(
  "n8n_delete_workflow",
  {
    description: "Permanently delete a workflow. A backup of its JSON is written first when a backup directory is configured.",
    inputSchema: { id: workflowId, confirmProduction },
    annotations: { destructiveHint: true },
  },
  ({ id, confirmProduction: confirmed }) =>
    respond(() => tools.deleteWorkflow(id, confirmed)),
);

await server.connect(new StdioServerTransport());
