import type { Json, JsonObject, N8nNode, N8nWorkflow } from "./n8nClient.js";

export type PatchOperation =
  | { op: "setName"; name: string }
  | { op: "mergeSettings"; settings: JsonObject }
  | { op: "addNode"; node: JsonObject }
  | { op: "updateNode"; name: string; changes: JsonObject }
  | { op: "removeNode"; name: string }
  | { op: "renameNode"; from: string; to: string }
  | {
      op: "connect";
      from: string;
      to: string;
      type?: string;
      fromIndex?: number;
      toIndex?: number;
    }
  | {
      op: "disconnect";
      from: string;
      to: string;
      type?: string;
      fromIndex?: number;
    };

interface ConnectionTarget extends JsonObject {
  node: string;
  type: string;
  index: number;
}

type ConnectionMap = Record<string, Record<string, ConnectionTarget[][]>>;

export interface PatchResult {
  workflow: N8nWorkflow;
  warnings: string[];
}

function isPlainObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// null removes a key, objects merge recursively, anything else (arrays included) replaces the value.
export function deepMerge(base: JsonObject, changes: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as JsonObject, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function findNode(nodes: N8nNode[], name: string): N8nNode {
  const node = nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`Node "${name}" not found`);
  return node;
}

function countExpressionReferences(nodes: N8nNode[], skip: string, target: string): number {
  const patterns = [`$('${target}')`, `$("${target}")`, `$node["${target}"]`, `$node['${target}']`];
  let count = 0;
  for (const node of nodes) {
    if (node.name === skip) continue;
    const serialized = JSON.stringify(node.parameters ?? {});
    // JSON.stringify escapes double quotes, so compare against the escaped form too.
    for (const pattern of patterns) {
      if (serialized.includes(pattern) || serialized.includes(pattern.replaceAll('"', '\\"'))) count++;
    }
  }
  return count;
}

function applyOperation(workflow: N8nWorkflow, operation: PatchOperation, warnings: string[]): void {
  const connections = workflow.connections as unknown as ConnectionMap;

  switch (operation.op) {
    case "setName":
      workflow.name = operation.name;
      return;

    case "mergeSettings":
      workflow.settings = deepMerge(workflow.settings, operation.settings);
      return;

    case "addNode": {
      const node = operation.node as N8nNode;
      if (typeof node.name !== "string" || typeof node.type !== "string") {
        throw new Error("addNode requires node.name and node.type");
      }
      if (workflow.nodes.some((existing) => existing.name === node.name)) {
        throw new Error(`Node "${node.name}" already exists`);
      }
      workflow.nodes.push(node);
      return;
    }

    case "updateNode": {
      const node = findNode(workflow.nodes, operation.name);
      const { parameters, name: newName, ...rest } = operation.changes;
      if (newName !== undefined) throw new Error('Use renameNode to change a node name (it also rewrites connections)');
      Object.assign(node, rest);
      if (parameters !== undefined) {
        if (!isPlainObject(parameters)) throw new Error("changes.parameters must be an object");
        node.parameters = deepMerge(isPlainObject(node.parameters) ? node.parameters : {}, parameters);
      }
      return;
    }

    case "removeNode": {
      findNode(workflow.nodes, operation.name);
      workflow.nodes = workflow.nodes.filter((node) => node.name !== operation.name);
      delete connections[operation.name];
      for (const byType of Object.values(connections)) {
        for (const outputs of Object.values(byType)) {
          for (let index = 0; index < outputs.length; index++) {
            outputs[index] = (outputs[index] ?? []).filter((target) => target.node !== operation.name);
          }
        }
      }
      return;
    }

    case "renameNode": {
      const node = findNode(workflow.nodes, operation.from);
      if (workflow.nodes.some((existing) => existing.name === operation.to)) {
        throw new Error(`Node "${operation.to}" already exists`);
      }
      const references = countExpressionReferences(workflow.nodes, operation.from, operation.from);
      node.name = operation.to;
      const outgoing = connections[operation.from];
      if (outgoing) {
        connections[operation.to] = outgoing;
        delete connections[operation.from];
      }
      for (const byType of Object.values(connections)) {
        for (const outputs of Object.values(byType)) {
          for (const targets of outputs) {
            for (const target of targets ?? []) {
              if (target.node === operation.from) target.node = operation.to;
            }
          }
        }
      }
      if (references > 0) {
        warnings.push(
          `${references} expression reference(s) to "${operation.from}" in other nodes were not rewritten and may now be broken`,
        );
      }
      return;
    }

    case "connect": {
      findNode(workflow.nodes, operation.from);
      findNode(workflow.nodes, operation.to);
      const type = operation.type ?? "main";
      const fromIndex = operation.fromIndex ?? 0;
      const toIndex = operation.toIndex ?? 0;
      const byType = (connections[operation.from] ??= {});
      const outputs = (byType[type] ??= []);
      while (outputs.length <= fromIndex) outputs.push([]);
      const targets = outputs[fromIndex] ?? [];
      outputs[fromIndex] = targets;
      const exists = targets.some(
        (target) => target.node === operation.to && target.type === type && target.index === toIndex,
      );
      if (!exists) targets.push({ node: operation.to, type, index: toIndex });
      return;
    }

    case "disconnect": {
      const type = operation.type ?? "main";
      const fromIndex = operation.fromIndex ?? 0;
      const outputs = connections[operation.from]?.[type];
      const targets = outputs?.[fromIndex];
      if (!outputs || !targets) return;
      outputs[fromIndex] = targets.filter((target) => target.node !== operation.to);
      return;
    }
  }
}

export function validateWorkflow(workflow: JsonObject): string[] {
  const issues: string[] = [];
  const nodes = Array.isArray(workflow.nodes) ? (workflow.nodes as N8nNode[]) : [];
  const names = new Set<string>();

  for (const node of nodes) {
    if (typeof node.name !== "string" || typeof node.type !== "string") {
      issues.push("Every node needs a string name and type");
      continue;
    }
    if (names.has(node.name)) issues.push(`Duplicate node name "${node.name}"`);
    names.add(node.name);
  }

  const connections = (workflow.connections ?? {}) as unknown as ConnectionMap;
  for (const [source, byType] of Object.entries(connections)) {
    if (!names.has(source)) issues.push(`Connection source "${source}" is not a node`);
    for (const outputs of Object.values(byType)) {
      for (const targets of outputs) {
        for (const target of targets ?? []) {
          if (!names.has(target.node)) issues.push(`Connection from "${source}" targets missing node "${target.node}"`);
        }
      }
    }
  }
  return issues;
}

export function applyPatch(original: N8nWorkflow, operations: PatchOperation[]): PatchResult {
  const workflow = structuredClone(original);
  const warnings: string[] = [];

  operations.forEach((operation, position) => {
    try {
      applyOperation(workflow, operation, warnings);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Operation #${position + 1} (${operation.op}) failed: ${reason}`);
    }
  });

  const issues = validateWorkflow(workflow);
  if (issues.length > 0) throw new Error(`Patched workflow is invalid: ${issues.join("; ")}`);
  return { workflow, warnings };
}
