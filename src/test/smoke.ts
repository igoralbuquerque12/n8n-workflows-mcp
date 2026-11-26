import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../config.js";
import type { JsonObject } from "../n8nClient.js";
import { Tools } from "../tools.js";

const TOP_LEVEL = new Set(["name", "nodes", "connections", "settings", "staticData", "description", "pinData", "nodeGroups", "projectId", "parentFolderId", "tags"]);
const SETTINGS = new Set(["executionOrder", "timezone", "availableInMCP", "callerPolicy"]);
// Node keys of the n8n public API node schema; anything else (e.g. the editor's rewireOutputLogTo) is rejected.
const NODE_KEYS = new Set(["id", "name", "type", "typeVersion", "position", "parameters", "credentials", "webhookId", "disabled", "notes", "notesInFlow", "retryOnFail", "maxTries", "waitBetweenTries", "alwaysOutputData", "executeOnce", "continueOnFail", "onError"]);

interface Stored extends JsonObject {
  id: string;
}

function startMockN8n(
  apiKey: string,
): Promise<{ server: Server; url: string; store: Map<string, Stored>; executions: Map<string, Stored>; executionPages: number[] }> {
  const store = new Map<string, Stored>();
  const executions = new Map<string, Stored>();
  // Page sizes requested on GET /executions, to check how far a search scanned.
  const executionPages: number[] = [];
  let counter = 0;

  const readBody = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      request.on("data", (chunk) => (data += chunk));
      request.on("end", () => resolve(data));
    });

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers["x-n8n-api-key"] !== apiKey) return send(401, { message: "unauthorized" });

    const url = new URL(request.url ?? "/", "http://localhost");

    const executionRoute = url.pathname.match(/^\/api\/v1\/executions(?:\/([^/]+))?(\/retry)?$/);
    if (executionRoute) {
      const [, executionId, retry] = executionRoute;
      const view = (execution: Stored) => (url.searchParams.get("includeData") === "true" ? execution : { ...execution, data: undefined });
      if (request.method === "GET" && !executionId) {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        executionPages.push(limit);
        const filtered = [...executions.values()]
          .filter((execution) => !url.searchParams.has("workflowId") || execution.workflowId === url.searchParams.get("workflowId"))
          .filter((execution) => !url.searchParams.has("status") || execution.status === url.searchParams.get("status"))
          .sort((a, b) => Number(b.id) - Number(a.id));
        const page = filtered.slice(offset, offset + limit);
        return send(200, { data: page.map(view), nextCursor: offset + limit < filtered.length ? String(offset + limit) : null });
      }
      const found = executions.get(executionId ?? "");
      if (!found) return send(404, { message: "not found" });
      if (request.method === "GET" && !retry) return send(200, view(found));
      if (request.method === "POST" && retry) {
        if (found.status === "success") return send(409, { message: "The execution succeeded, so it cannot be retried." });
        const body = JSON.parse((await readBody(request)) || "{}") as JsonObject;
        const newId = String(Math.max(...[...executions.keys()].map(Number)) + 1);
        const retried: Stored = { ...found, id: newId, status: "success", retryOf: found.id, mode: "retry", loadWorkflow: body.loadWorkflow ?? null };
        executions.set(newId, retried);
        found.retrySuccessId = newId;
        return send(200, retried);
      }
      return send(405, { message: "method not allowed" });
    }

    const match =url.pathname.match(/^\/api\/v1\/workflows(?:\/([^/]+))?(?:\/(activate|deactivate|archive))?$/);
    if (!match) return send(404, { message: "not found" });
    const [, id, action] = match;

    if (request.method === "GET" && !id) return send(200, { data: [...store.values()], nextCursor: null });
    if (request.method === "GET" && id) {
      const found = store.get(id);
      return found ? send(200, found) : send(404, { message: "not found" });
    }

    if (request.method === "POST" && id && action) {
      const found = store.get(id);
      if (!found) return send(404, { message: "not found" });
      found.active = action === "activate";
      return send(200, found);
    }

    if (request.method === "DELETE" && id) {
      const found = store.get(id);
      store.delete(id ?? "");
      return found ? send(200, found) : send(404, { message: "not found" });
    }

    if ((request.method === "POST" && !id) || (request.method === "PUT" && id)) {
      const body = JSON.parse(await readBody(request)) as JsonObject;
      const extra = Object.keys(body).filter((key) => !TOP_LEVEL.has(key));
      if (extra.length > 0) return send(400, { message: `request/body must NOT have additional properties: ${extra.join(",")}` });
      // The real API rejects description: null (as GET returns it) with this same message.
      const nullFields = Object.keys(body).filter((key) => body[key] === null);
      if (nullFields.length > 0) return send(400, { message: `request/body must NOT have additional properties: ${nullFields.join(",")}` });
      const bodyNodes = (Array.isArray(body.nodes) ? body.nodes : []) as JsonObject[];
      const badNode = bodyNodes.findIndex((node) => Object.keys(node).some((key) => !NODE_KEYS.has(key)));
      if (badNode >= 0) return send(400, { message: `request/body/nodes/${badNode} must NOT have additional properties` });
      const badSetting = Object.keys((body.settings ?? {}) as JsonObject).filter((key) => !SETTINGS.has(key));
      if (badSetting.length > 0) return send(400, { message: `settings must NOT have additional properties: ${badSetting.join(",")}` });

      const workflowId = id ?? String(++counter);
      const saved: Stored = { ...body, id: workflowId, active: store.get(workflowId)?.active ?? false, createdAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-25T00:00:00Z" } as Stored;
      store.set(workflowId, saved);
      return send(200, saved);
    }
    return send(405, { message: "method not allowed" });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, executions, executionPages }),
    ),
  );
}

const baseWorkflow = (name: string): JsonObject => ({
  name,
  nodes: [
    { id: "1", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "hook", options: { rawBody: false } } },
    { id: "2", name: "Set", type: "n8n-nodes-base.set", typeVersion: 3, position: [200, 0], parameters: { mode: "manual" } },
  ],
  connections: { Webhook: { main: [[{ node: "Set", type: "main", index: 0 }]] } },
  settings: { executionOrder: "v1" },
});

async function expectRejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, pattern);
}

const n8n = await startMockN8n("test-key");
const backupDir = mkdtempSync(path.join(tmpdir(), "n8n-backup-"));

const env = {
  N8N_URL: n8n.url + "/",
  N8N_API_KEY: "test-key",
  N8N_PROTECTED_NAMES: "production",
  N8N_BACKUP_DIR: backupDir,
};
const tools = new Tools(loadConfig(env));

assert.throws(() => loadConfig({ N8N_URL: n8n.url }), /N8N_URL and N8N_API_KEY/);
assert.throws(() => loadConfig({ N8N_API_KEY: "test-key" }), /N8N_URL and N8N_API_KEY/);
assert.equal(loadConfig(env).baseUrl, n8n.url);

const created = await tools.createWorkflow(baseWorkflow("[Staging] Robo"));
assert.equal(created.name, "[Staging] Robo");

const patched = await tools.patchWorkflow(created.id, [
  { op: "addNode", node: { id: "3", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1, position: [400, 0], parameters: {} } },
  { op: "connect", from: "Set", to: "Respond" },
  { op: "updateNode", name: "Webhook", changes: { parameters: { options: { rawBody: null, ipWhitelist: "1.1.1.1" } }, disabled: false } },
  { op: "renameNode", from: "Set", to: "Prepare" },
  { op: "mergeSettings", settings: { timezone: "America/Sao_Paulo" } },
], {});
const stored = n8n.store.get(created.id) as JsonObject;
const nodes = stored.nodes as { name: string; parameters: JsonObject }[];
assert.deepEqual(nodes.map((node) => node.name), ["Webhook", "Prepare", "Respond"]);
assert.deepEqual((nodes[0] as { parameters: JsonObject }).parameters, { path: "hook", options: { ipWhitelist: "1.1.1.1" } });
assert.deepEqual(stored.connections, {
  Webhook: { main: [[{ node: "Prepare", type: "main", index: 0 }]] },
  Prepare: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
});
assert.equal((stored.settings as JsonObject).timezone, "America/Sao_Paulo");
assert.ok(patched.warnings.length === 0);

const dry = await tools.patchWorkflow(created.id, [{ op: "setName", name: "[Staging] Renamed" }], { dryRun: true });
assert.equal((dry as { dryRun: boolean }).dryRun, true);
assert.equal(n8n.store.get(created.id)?.name, "[Staging] Robo");

await expectRejects(
  tools.patchWorkflow(created.id, [{ op: "removeNode", name: "Ghost" }], {}),
  /Operation #1 \(removeNode\) failed: Node "Ghost" not found/,
);
await expectRejects(
  tools.patchWorkflow(created.id, [{ op: "addNode", node: { id: "9", name: "Respond", type: "x", typeVersion: 1, position: [0, 0], parameters: {} } }], {}),
  /already exists/,
);
assert.equal((n8n.store.get(created.id)?.nodes as unknown[]).length, 3);

const removed = await tools.patchWorkflow(created.id, [{ op: "removeNode", name: "Prepare" }], {});
assert.deepEqual((removed as { workflow: JsonObject }).workflow.connections, { Webhook: { main: [[]] } });

const roundTrip = await tools.getWorkflow(created.id);
await tools.updateWorkflow(created.id, { ...roundTrip, settings: { ...roundTrip.settings, binaryMode: "separate" } }, {});

// A workflow as the n8n editor leaves it: description: null on top, rewireOutputLogTo on a converted tool node.
const editorExport = (): Stored => ({
  ...baseWorkflow("[Staging] Editor export"),
  id: "55",
  active: false,
  description: null,
  nodes: [
    ...(baseWorkflow("x").nodes as JsonObject[]),
    { id: "3", name: "Execute_Backend_Tool", type: "n8n-nodes-base.httpRequestTool", typeVersion: 4.2, position: [400, 0], parameters: { url: "https://example.com" }, rewireOutputLogTo: "ai_tool" },
  ],
});
const editorWarning = 'node "Execute_Backend_Tool": dropped editor-only key rewireOutputLogTo';
const assertSentClean = () => {
  const saved = n8n.store.get("55") as JsonObject;
  assert.equal("description" in saved, false);
  assert.equal((saved.nodes as JsonObject[]).some((node) => "rewireOutputLogTo" in node), false);
};

n8n.store.set("55", editorExport());
const editorDry = await tools.patchWorkflow("55", [{ op: "mergeSettings", settings: { timezone: "UTC" } }], { dryRun: true });
assert.deepEqual(editorDry.warnings, [editorWarning]);
const editorPatch = await tools.patchWorkflow("55", [{ op: "mergeSettings", settings: { timezone: "UTC" } }], {});
assert.deepEqual(editorPatch.warnings, [editorWarning]);
assertSentClean();
assert.equal(((n8n.store.get("55") as JsonObject).settings as JsonObject).timezone, "UTC");
const editorBackup = JSON.parse(readFileSync(editorPatch.backup ?? "", "utf8")) as JsonObject;
assert.equal(editorBackup.description, null);
assert.equal((editorBackup.nodes as JsonObject[])[2]?.rewireOutputLogTo, "ai_tool");

n8n.store.set("55", editorExport());
const editorJson = await tools.getWorkflow("55");
const editorUpdate = await tools.updateWorkflow("55", editorJson, {});
assert.deepEqual(editorUpdate.warnings, [editorWarning]);
assertSentClean();
assert.equal((editorJson.nodes[2] as JsonObject).rewireOutputLogTo, "ai_tool");
assert.equal(editorJson.description, null);

await expectRejects(tools.createWorkflow(baseWorkflow("[Production] Flow")), /needs explicit user approval/);
const prodCreated = await tools.createWorkflow(baseWorkflow("[Production] Flow"), true);
await expectRejects(
  tools.patchWorkflow(prodCreated.id, [{ op: "setName", name: "[Production] Flow 2" }], {}),
  /needs explicit user approval/,
);
assert.equal(n8n.store.get(prodCreated.id)?.name, "[Production] Flow");
await tools.patchWorkflow(prodCreated.id, [{ op: "setName", name: "[Production] Flow 2" }], { confirmProduction: true });
assert.equal(n8n.store.get(prodCreated.id)?.name, "[Production] Flow 2");

const temp = await tools.createWorkflow(baseWorkflow("[Staging] temp"));
await expectRejects(
  tools.patchWorkflow(temp.id, [{ op: "setName", name: "[Production] Promoted" }], {}),
  /needs explicit user approval/,
);
assert.equal(n8n.store.get(temp.id)?.name, "[Staging] temp");

n8n.store.set("77", { ...(n8n.store.get(temp.id) as Stored), id: "77", name: "[Production] Robo" });
await expectRejects(tools.setActive("77", true), /needs explicit user approval/);
await tools.setActive("77", true, true);
assert.equal(n8n.store.get("77")?.active, true);

const confirmOnly = new Tools(loadConfig({ ...env, N8N_ACCESS: "confirm" }));
await expectRejects(confirmOnly.createWorkflow(baseWorkflow("[Staging] Needs ok")), /needs explicit user approval/);

await expectRejects(
  tools.createWorkflow({ ...baseWorkflow("Broken"), connections: { Webhook: { main: [[{ node: "Nowhere", type: "main", index: 0 }]] } } }),
  /targets missing node "Nowhere"/,
);

const tempJson = await tools.getWorkflow(temp.id);
await expectRejects(tools.updateWorkflow(temp.id, { ...tempJson, name: "[Production] Via update" }, {}), /needs explicit user approval/);
assert.equal(n8n.store.get(temp.id)?.name, "[Staging] temp");

const names = loadConfig({ ...env, N8N_PROTECTED_NAMES: "production, prod" }).protectedNames;
assert.ok(names?.test("Pillot AI - Prod"));
assert.ok(names?.test("[Production] - Chatwoot"));
assert.ok(names?.test("fluxo PROD v2"));
assert.equal(names?.test("Product sync"), false);
assert.equal(names?.test("Pillot AI Staging - Igor"), false);
assert.throws(() => loadConfig({ N8N_URL: n8n.url, N8N_API_KEY: "test-key", N8N_BLOCK_PROTECTED: "true" }), /N8N_PROTECTED_NAMES/);
assert.throws(() => loadConfig({ ...env, N8N_BLOCK_PROTECTED: "yes" }), /expected true or false/);
assert.throws(() => loadConfig({ ...env, N8N_PROTECTED_NAME_PATTERN: "^\\[production\\]" }), /was removed/);

const blocked = new Tools(loadConfig({ ...env, N8N_PROTECTED_NAMES: "production,prod", N8N_BLOCK_PROTECTED: "true" }));
n8n.store.set("88", { ...(n8n.store.get(temp.id) as Stored), id: "88", name: "Pillot AI - Prod" });
const visibleIds = (await blocked.listWorkflows({})).workflows.map((workflow) => workflow.id);
assert.ok(visibleIds.includes(created.id));
assert.equal(visibleIds.includes("88"), false);
assert.equal(visibleIds.includes(prodCreated.id), false);
await expectRejects(blocked.getWorkflow("88"), /N8N_BLOCK_PROTECTED/);
await expectRejects(blocked.patchWorkflow("88", [{ op: "setName", name: "Renamed" }], { confirmProduction: true }), /N8N_BLOCK_PROTECTED/);
await expectRejects(blocked.setActive(prodCreated.id, true, true), /N8N_BLOCK_PROTECTED/);
await expectRejects(blocked.deleteWorkflow("88", true), /N8N_BLOCK_PROTECTED/);
await expectRejects(blocked.createWorkflow(baseWorkflow("Fluxo Prod"), true), /N8N_BLOCK_PROTECTED/);
await expectRejects(
  blocked.patchWorkflow(temp.id, [{ op: "setName", name: "[Staging] temp prod" }], { confirmProduction: true }),
  /N8N_BLOCK_PROTECTED/,
);
assert.equal(n8n.store.get("88")?.name, "Pillot AI - Prod");
assert.equal(n8n.store.get(temp.id)?.name, "[Staging] temp");
assert.equal((await blocked.getWorkflow(created.id)).id, created.id);
n8n.store.delete("88");

const backupsBeforeDelete = readdirSync(backupDir).length;
assert.ok(backupsBeforeDelete >= 1);
const deleted = await tools.deleteWorkflow(temp.id);
assert.equal(deleted.deleted.id, temp.id);
assert.equal(n8n.store.has(temp.id), false);
assert.equal(readdirSync(backupDir).length, backupsBeforeDelete + 1);
assert.ok(existsSync(deleted.backup ?? ""));

const readOnly = new Tools(loadConfig({ ...env, N8N_ACCESS: "read" }));
await expectRejects(readOnly.setActive(prodCreated.id, true, true), /read-only/);
await expectRejects(readOnly.createWorkflow(baseWorkflow("[Staging] Nope"), true), /read-only/);
assert.equal((await readOnly.listWorkflows({})).workflows.length, n8n.store.size);

// ---- Executions ----
n8n.store.set("w-exec", { ...baseWorkflow("[Staging] Atendimento"), id: "w-exec" } as Stored);
n8n.store.set("w-prod-exec", { ...baseWorkflow("[Production] Atendimento"), id: "w-prod-exec" } as Stored);

const item = (json: JsonObject) => ({ json, pairedItem: { item: 0 } });
const run = (startTime: number, data: JsonObject, extra: JsonObject = {}) => ({
  startTime,
  executionTime: 12,
  executionStatus: "success",
  source: [],
  data,
  ...extra,
});
const execution = (id: number, workflowId: string, status: string, startedAt: string, runData: JsonObject, error?: JsonObject): Stored => ({
  id: String(id),
  workflowId,
  status,
  mode: "webhook",
  finished: status === "success",
  startedAt,
  stoppedAt: new Date(Date.parse(startedAt) + 1500).toISOString(),
  data: { resultData: { runData, lastNodeExecuted: Object.keys(runData).at(-1) ?? null, ...(error ? { error } : {}) } },
});
const webhookRun = (time: number, phone: string) => ({ Webhook: [run(time, { main: [[item({ body: { phone, name: "Ana" } })]] })] });

// 60 old executions, then the four this test looks at (ids 61-64, newest last).
for (let id = 1; id <= 60; id++) {
  n8n.executions.set(String(id), execution(id, "w-exec", "success", `2026-11-23T10:${String(id % 60).padStart(2, "0")}:00.000Z`, webhookRun(0, `55110000${id}`)));
}
const t2 = Date.parse("2026-11-25T15:00:00.000Z");
const httpError = { message: "Request failed with status code 500", description: "upstream down", httpCode: "500", node: { name: "HTTP Request" }, stack: "NodeApiError: Request failed\n    at HttpRequest.execute" };
n8n.executions.set("61", execution(61, "w-exec", "success", "2026-11-24T10:00:00.000Z", webhookRun(0, "5511988887777")));
n8n.executions.set("62", execution(62, "w-exec", "error", "2026-11-25T15:00:00.000Z", {
  // Stored out of order: get_execution must sort by startTime.
  "HTTP Request": [run(t2 + 30, {}, { executionStatus: "error", source: [{ previousNode: "IF", previousNodeOutput: 1 }], error: httpError })],
  Webhook: [run(t2, { main: [[item({ body: { phone: "5511977776666", note: "x".repeat(1000) } }), item({ n: 2 }), item({ n: 3 }), item({ n: 4 })]] })],
  IF: [run(t2 + 10, { main: [[], [{ json: { ok: true }, binary: { file: { fileName: "a.pdf", mimeType: "application/pdf", fileSize: "10 kB", data: "QUJD" } } }]] }, { source: [{ previousNode: "Webhook" }] })],
}, httpError));
n8n.executions.set("63", execution(63, "w-prod-exec", "success", "2026-11-25T16:00:00.000Z", webhookRun(0, "5511988887777")));
n8n.executions.set("64", execution(64, "deleted-wf", "error", "2026-11-26T09:00:00.000Z", webhookRun(0, "5511988887777"), { message: "boom" }));

const errors = await tools.listExecutions({ status: "error" });
assert.deepEqual(errors.executions.map((entry) => entry.id), ["64", "62"]);
const failed = errors.executions[1] as JsonObject;
assert.equal(failed.workflowName, "[Staging] Atendimento");
assert.equal(failed.durationMs, 1500);
assert.deepEqual(failed.error, { node: "HTTP Request", message: "Request failed with status code 500", description: "upstream down", httpCode: "500" });
assert.equal(errors.executions[0]?.workflowName, null);
const plainPage = await tools.listExecutions({ workflowId: "w-exec", limit: 5 });
assert.equal(plainPage.executions.length, 5);
assert.equal(plainPage.nextCursor, "5");
assert.equal("error" in (plainPage.executions[0] as JsonObject), false);

const detail = await tools.getExecution("62", {});
assert.deepEqual(detail.nodes.map((node) => node.node), ["Webhook", "IF", "HTTP Request"]);
const [webhookStep, ifStep, httpStep] = detail.nodes as JsonObject[];
const webhookOut = (webhookStep?.outputs as JsonObject[])[0] as JsonObject;
assert.equal(webhookOut.itemCount, 4);
assert.equal((webhookOut.items as JsonObject[]).length, 3);
assert.match(JSON.stringify(webhookOut.items), /\[\+700 chars\]/);
assert.equal(JSON.stringify(webhookOut.items).includes("pairedItem"), false);
assert.deepEqual((ifStep?.outputs as JsonObject[]).map((output) => output.itemCount), [0, 1]);
assert.deepEqual(ifStep?.from, ["Webhook"]);
assert.deepEqual(((ifStep?.outputs as JsonObject[])[1]?.items as JsonObject[])[0], {
  json: { ok: true },
  binary: { file: { fileName: "a.pdf", mimeType: "application/pdf", fileSize: "10 kB" } },
});
assert.deepEqual(httpStep?.from, ["IF (output 1)"]);
assert.equal((httpStep?.error as JsonObject).message, "Request failed with status code 500");
assert.match(String(detail.errorStack), /NodeApiError/);
const focused = await tools.getExecution("62", { nodes: ["Webhook", "Ghost"], itemsPerOutput: 1, maxStringLength: 2000 });
assert.deepEqual(focused.nodes.map((node) => node.node), ["Webhook"]);
assert.match(focused.warnings[0] ?? "", /Ghost/);
assert.equal(JSON.stringify(focused.nodes).includes("[+"), false);

const byPhone = await tools.searchExecutions({ text: "5511988887777" });
assert.deepEqual(byPhone.results.map((result) => result.id), ["64", "63", "61"]);
assert.equal(byPhone.stoppedBecause, "noMoreExecutions");
assert.equal(byPhone.scanned, 64);
assert.deepEqual((byPhone.results[2]?.matches as unknown as { node: string; path: string; snippet: string }[])[0], {
  node: "Webhook",
  path: "main[0][0].json.body.phone",
  snippet: "5511988887777",
});
const firstOnly = await tools.searchExecutions({ text: "5511988887777", maxResults: 1 });
assert.equal(firstOnly.stoppedBecause, "maxResults");
assert.equal(firstOnly.nextCursor, "50");
const rest = await tools.searchExecutions({ text: "5511988887777", cursor: firstOnly.nextCursor ?? undefined });
assert.equal(rest.scanned, 14);
assert.equal(rest.results.length, 0);

n8n.executionPages.length = 0;
const windowed = await tools.searchExecutions({ text: "55119888", startedAfter: "2026-11-25T00:00:00Z", startedBefore: "2026-11-25T23:59:59Z" });
assert.deepEqual(windowed.results.map((result) => result.id), ["63"]);
assert.equal(windowed.stoppedBecause, "reachedStartedAfter");
assert.equal(windowed.nextCursor, null);
assert.deepEqual(n8n.executionPages, [50, 50]);

const byRegex = await tools.searchExecutions({ regex: "status code 5\\d\\d", workflowId: "w-exec" });
assert.deepEqual(byRegex.results.map((result) => result.id), ["62"]);
assert.deepEqual((byRegex.results[0]?.matches as unknown as { node: string; path: string }[]).map((m) => `${m.node}:${m.path}`), ["HTTP Request:error.message"]);
const inNode = await tools.searchExecutions({ text: "5511977776666", nodes: ["IF"] });
assert.equal(inNode.results.length, 0);
const capped = await tools.searchExecutions({ text: "nothing-here", scanLimit: 10 });
assert.equal(capped.scanned, 10);
assert.equal(capped.stoppedBecause, "scanLimit");
const byDate = await tools.searchExecutions({ startedAfter: "2026-11-26T00:00:00Z" });
assert.deepEqual(byDate.results.map((result) => result.id), ["64"]);
await expectRejects(tools.searchExecutions({ text: "a", regex: "a" }), /either text or regex/);
await expectRejects(tools.searchExecutions({ regex: "(" }), /Invalid regex/);
await expectRejects(tools.searchExecutions({ startedAfter: "ontem" }), /Invalid startedAfter/);

const blockedIds = (await blocked.searchExecutions({ text: "5511988887777" })).results.map((result) => result.id);
assert.deepEqual(blockedIds, ["61"]);
assert.equal((await blocked.listExecutions({ status: "error" })).executions.length, 1);
await expectRejects(blocked.getExecution("63", {}), /N8N_BLOCK_PROTECTED/);
await expectRejects(blocked.getExecution("64", {}), /no longer exists/);
await expectRejects(blocked.listExecutions({ workflowId: "w-prod-exec" }), /N8N_BLOCK_PROTECTED/);
await expectRejects(blocked.retryExecution("63", { confirmProduction: true }), /N8N_BLOCK_PROTECTED/);

const retried = await tools.retryExecution("62", { loadWorkflow: true });
assert.equal(retried.retriedFrom, "62");
assert.equal(retried.execution.retryOf, "62");
assert.equal(retried.execution.workflowName, "[Staging] Atendimento");
assert.equal(n8n.executions.get(String(retried.execution.id))?.loadWorkflow, true);
await expectRejects(tools.retryExecution("61", {}), /409/);
n8n.executions.set("63", { ...(n8n.executions.get("63") as Stored), status: "error" });
await expectRejects(tools.retryExecution("63", {}), /needs explicit user approval/);
await expectRejects(readOnly.retryExecution("62", { confirmProduction: true }), /read-only/);
await expectRejects(tools.retryExecution("64", {}), /no longer exists/);

const serverEntry =path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry], env: { ...env, PATH: process.env.PATH ?? "" } }));
const listed = await client.listTools();
assert.deepEqual(
  listed.tools.map((tool) => tool.name).sort(),
  [
    "n8n_create_workflow",
    "n8n_delete_workflow",
    "n8n_get_execution",
    "n8n_get_workflow",
    "n8n_list_executions",
    "n8n_list_workflows",
    "n8n_patch_workflow",
    "n8n_retry_execution",
    "n8n_search_executions",
    "n8n_set_workflow_active",
    "n8n_set_workflow_archived",
    "n8n_update_workflow",
  ],
);
const searchViaMcp = await client.callTool({ name: "n8n_search_executions", arguments: { text: "5511977776666" } });
assert.notEqual(searchViaMcp.isError, true, JSON.stringify(searchViaMcp.content));
assert.match(JSON.stringify(searchViaMcp.content), /\\"id\\": \\"62\\"/);
const viaMcp = await client.callTool({
  name: "n8n_patch_workflow",
  arguments: { id: prodCreated.id, operations: [{ op: "setName", name: "[Production] Nope" }] },
});
assert.equal(viaMcp.isError, true);
const okViaMcp = await client.callTool({
  name: "n8n_patch_workflow",
  arguments: { id: created.id, operations: [{ op: "setName", name: "[Staging] Via MCP" }] },
});
assert.notEqual(okViaMcp.isError, true);
assert.equal(n8n.store.get(created.id)?.name, "[Staging] Via MCP");

for (const [name, args] of [
  ["n8n_patch_workflow", { id: "55", operations: [{ op: "setName", name: "[Staging] Editor export 2" }] }],
  ["n8n_update_workflow", { id: "55", workflow: editorExport() }],
] as const) {
  n8n.store.set("55", editorExport());
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  assert.ok(JSON.stringify(result.content).includes("dropped editor-only key rewireOutputLogTo"), name);
  assertSentClean();
}
await client.close();

n8n.server.close();
console.log("smoke ok");
