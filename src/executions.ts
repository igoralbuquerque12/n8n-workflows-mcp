import type { ExecutionStatus, Json, JsonObject, N8nExecution } from "./n8nClient.js";

export interface TrimOptions {
  /** Items shown per node output. */
  itemsPerOutput: number;
  /** Longer strings are cut and marked with the number of hidden characters. */
  maxStringLength: number;
}

const MAX_ARRAY = 20;
const MAX_DEPTH = 8;
const SNIPPET_RADIUS = 60;

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: Json | undefined): JsonObject {
  return isObject(value) ? value : {};
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
}

export function trimValue(value: Json, maxStringLength: number, depth = 0): Json {
  if (typeof value === "string") return cut(value, maxStringLength);
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_ARRAY).map((entry) => trimValue(entry, maxStringLength, depth + 1));
    if (value.length > MAX_ARRAY) shown.push(`… [+${value.length - MAX_ARRAY} more items]`);
    return shown;
  }
  if (isObject(value)) {
    if (depth >= MAX_DEPTH) return "[… nested too deep]";
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimValue(entry, maxStringLength, depth + 1)]));
  }
  return value;
}

/** Binary payloads are replaced by their metadata; the file content is never returned. */
function trimItem(item: Json, maxStringLength: number): Json {
  if (!isObject(item)) return trimValue(item, maxStringLength);
  const out: JsonObject = { json: trimValue(item.json ?? null, maxStringLength) };
  if (isObject(item.binary)) {
    out.binary = Object.fromEntries(
      Object.entries(item.binary).map(([key, file]) => {
        const meta = asObject(file);
        return [key, { fileName: meta.fileName ?? null, mimeType: meta.mimeType ?? null, fileSize: meta.fileSize ?? null }];
      }),
    );
  }
  return out;
}

function resultData(execution: N8nExecution): JsonObject {
  return asObject(asObject(execution.data).resultData);
}

function runData(execution: N8nExecution): Record<string, JsonObject[]> {
  const raw = asObject(resultData(execution).runData);
  return Object.fromEntries(
    Object.entries(raw).map(([node, runs]) => [node, Array.isArray(runs) ? runs.filter(isObject) : []]),
  );
}

export function executionStatus(execution: N8nExecution): ExecutionStatus {
  if (typeof execution.status === "string") return execution.status as ExecutionStatus;
  if (execution.waitTill) return "waiting";
  if (execution.finished === true) return "success";
  if (execution.stoppedAt) return "error";
  return "running";
}

/** When the execution started, falling back to when it was created (queued executions have no startedAt yet). */
export function executionStart(execution: N8nExecution): number | null {
  const raw = asString(execution.startedAt) ?? asString(execution.createdAt);
  if (raw === null) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : time;
}

function errorSummary(error: Json | undefined, maxStringLength: number): JsonObject | null {
  if (!isObject(error)) return null;
  const out: JsonObject = {
    node: asString(asObject(error.node).name),
    message: cut(asString(error.message) ?? "", maxStringLength),
  };
  const description = asString(error.description);
  if (description) out.description = cut(description, maxStringLength);
  const httpCode = asString(error.httpCode);
  if (httpCode) out.httpCode = httpCode;
  return out;
}

export function summarizeExecution(execution: N8nExecution, workflowName?: string | null) {
  const start = executionStart(execution);
  const stoppedAt = asString(execution.stoppedAt);
  const stop = stoppedAt ? Date.parse(stoppedAt) : NaN;
  const result = resultData(execution);
  const error = errorSummary(result.error, 500);
  if (error && error.node === null) error.node = asString(result.lastNodeExecuted);

  const summary: JsonObject = {
    id: String(execution.id),
    workflowId: execution.workflowId === undefined || execution.workflowId === null ? null : String(execution.workflowId),
    workflowName: workflowName ?? null,
    status: executionStatus(execution),
    mode: asString(execution.mode),
    startedAt: asString(execution.startedAt),
    stoppedAt,
    durationMs: start !== null && !Number.isNaN(stop) ? stop - start : null,
  };
  if (execution.retryOf) summary.retryOf = String(execution.retryOf);
  if (execution.retrySuccessId) summary.retrySuccessId = String(execution.retrySuccessId);
  if (execution.data !== undefined) {
    summary.lastNodeExecuted = asString(result.lastNodeExecuted);
    summary.error = error;
  }
  return summary;
}

function describeSource(source: Json | undefined): string[] {
  if (!Array.isArray(source)) return [];
  return source.filter(isObject).map((entry) => {
    const node = asString(entry.previousNode) ?? "?";
    const output = typeof entry.previousNodeOutput === "number" && entry.previousNodeOutput > 0 ? ` (output ${entry.previousNodeOutput})` : "";
    return `${node}${output}`;
  });
}

function describeOutputs(data: Json | undefined, options: TrimOptions) {
  const outputs: JsonObject[] = [];
  for (const [type, branches] of Object.entries(asObject(data))) {
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => {
      const items = Array.isArray(branch) ? branch : [];
      const output: JsonObject = { type, index, itemCount: items.length };
      if (items.length > 0) {
        output.items = items.slice(0, options.itemsPerOutput).map((item) => trimItem(item, options.maxStringLength));
      }
      outputs.push(output);
    });
  }
  return outputs;
}

/**
 * The nodes that ran, in the order they started, with a trimmed view of what each produced.
 * `nodes` limits the result to those node names.
 */
export function describeExecution(execution: N8nExecution, options: TrimOptions & { nodes?: string[] }) {
  const runs = runData(execution);
  const wanted = options.nodes && options.nodes.length > 0 ? new Set(options.nodes) : null;
  const warnings: string[] = [];
  if (wanted) {
    const missing = [...wanted].filter((node) => !(node in runs));
    if (missing.length > 0) {
      warnings.push(`Did not run in this execution: ${missing.join(", ")}. Nodes that ran: ${Object.keys(runs).join(", ") || "none"}`);
    }
  }

  const steps: (JsonObject & { sortKey: number })[] = [];
  for (const [node, nodeRuns] of Object.entries(runs)) {
    if (wanted && !wanted.has(node)) continue;
    nodeRuns.forEach((run, runIndex) => {
      const startTime = typeof run.startTime === "number" ? run.startTime : Number.MAX_SAFE_INTEGER;
      const step: JsonObject & { sortKey: number } = {
        sortKey: startTime,
        node,
        run: runIndex,
        status: asString(run.executionStatus) ?? (run.error ? "error" : "success"),
        startedAt: startTime === Number.MAX_SAFE_INTEGER ? null : new Date(startTime).toISOString(),
        executionTimeMs: typeof run.executionTime === "number" ? run.executionTime : null,
        from: describeSource(run.source),
        outputs: describeOutputs(run.data, options),
      };
      if (run.inputOverride !== undefined) step.input = describeOutputs(run.inputOverride, options);
      const error = errorSummary(run.error, options.maxStringLength);
      if (error) step.error = error;
      steps.push(step);
    });
  }
  steps.sort((a, b) => a.sortKey - b.sortKey);

  const error = asObject(resultData(execution).error);
  const stack = asString(error.stack);
  return {
    warnings,
    errorStack: stack ? cut(stack, options.maxStringLength * 4) : null,
    nodes: steps.map(({ sortKey: _sortKey, ...step }) => step),
  };
}

export type Matcher = (text: string) => { index: number; length: number } | null;

export function buildMatcher(text: string | undefined, regex: string | undefined): Matcher | null {
  if (text !== undefined && regex !== undefined) throw new Error("Use either text or regex, not both");
  if (text !== undefined) {
    const needle = text.toLowerCase();
    if (needle === "") throw new Error("text must not be empty");
    return (value) => {
      const index = value.toLowerCase().indexOf(needle);
      return index >= 0 ? { index, length: needle.length } : null;
    };
  }
  if (regex !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(regex, "iu");
    } catch (error) {
      throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
    }
    return (value) => {
      const found = pattern.exec(value);
      return found ? { index: found.index, length: found[0].length } : null;
    };
  }
  return null;
}

export interface Match {
  node: string;
  path: string;
  snippet: string;
}

function snippet(value: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(value.length, index + length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}

/**
 * Searches the JSON values (not the keys, not binary content) that each node received or produced,
 * plus node and execution errors. Returns at most `limit` matches.
 */
export function findMatches(execution: N8nExecution, matcher: Matcher, options: { nodes?: string[]; limit: number }): Match[] {
  const matches: Match[] = [];
  const wanted = options.nodes && options.nodes.length > 0 ? new Set(options.nodes) : null;

  const walk = (node: string, value: Json | undefined, path: string, depth: number): void => {
    if (matches.length >= options.limit || value === undefined || value === null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      const found = matcher(text);
      if (found) matches.push({ node, path, snippet: snippet(text, found.index, found.length) });
      return;
    }
    if (depth > 30) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(node, entry, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, entry] of Object.entries(value)) walk(node, entry, path ? `${path}.${key}` : key, depth + 1);
  };

  const walkItems = (node: string, data: Json | undefined, prefix: string) => {
    for (const [type, branches] of Object.entries(asObject(data))) {
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, outputIndex) => {
        if (!Array.isArray(branch)) return;
        branch.forEach((item, itemIndex) => {
          walk(node, asObject(item).json, `${prefix}${type}[${outputIndex}][${itemIndex}].json`, 0);
        });
      });
    }
  };

  const runs = runData(execution);
  for (const [node, nodeRuns] of Object.entries(runs)) {
    if (wanted && !wanted.has(node)) continue;
    nodeRuns.forEach((run, runIndex) => {
      const prefix = runIndex > 0 ? `run[${runIndex}].` : "";
      walkItems(node, run.inputOverride, `${prefix}input.`);
      walkItems(node, run.data, prefix);
      const error = asObject(run.error);
      walk(node, { message: error.message ?? null, description: error.description ?? null }, `${prefix}error`, 0);
    });
  }

  const error = asObject(resultData(execution).error);
  const errorNode = asString(asObject(error.node).name) ?? "(execution)";
  // The execution error usually repeats the failing node's own error, which was already searched.
  const alreadySearched = (runs[errorNode] ?? []).some((run) => isObject(run.error));
  if (!alreadySearched && (!wanted || wanted.has(errorNode))) {
    walk(errorNode, { message: error.message ?? null, description: error.description ?? null }, "executionError", 0);
  }

  return matches;
}
