import type { Config } from "./config.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface N8nNode extends JsonObject {
  name: string;
  type: string;
}

export interface N8nWorkflow extends JsonObject {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: JsonObject;
  settings: JsonObject;
}

export interface ListQuery {
  name?: string;
  active?: boolean;
  tags?: string;
  projectId?: string;
  limit?: number;
  cursor?: string;
}

export class N8nApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
  }
}

const CREATE_FIELDS = [
  "name",
  "nodes",
  "connections",
  "settings",
  "staticData",
  "description",
  "pinData",
  "nodeGroups",
  "projectId",
  "parentFolderId",
  "tags",
] as const;

const UPDATE_FIELDS = [
  "name",
  "nodes",
  "connections",
  "settings",
  "staticData",
  "description",
  "pinData",
  "nodeGroups",
  "parentFolderId",
] as const;

// The API documents these settings as derived or ignored on write; older versions reject them as unknown properties.
const READ_ONLY_SETTINGS = ["binaryMode", "engineType", "credentialResolverId"];

function pick(source: JsonObject, fields: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function sanitizeSettings(settings: Json | undefined): JsonObject {
  const copy: JsonObject = { ...((settings as JsonObject | undefined) ?? {}) };
  for (const key of READ_ONLY_SETTINGS) delete copy[key];
  return copy;
}

export function toCreateBody(workflow: JsonObject): JsonObject {
  const body = pick(workflow, CREATE_FIELDS);
  body.settings = sanitizeSettings(body.settings);
  return body;
}

export function toUpdateBody(workflow: JsonObject): JsonObject {
  const body = pick(workflow, UPDATE_FIELDS);
  body.settings = sanitizeSettings(body.settings);
  return body;
}

export class N8nClient {
  constructor(private readonly connection: Pick<Config, "baseUrl" | "apiKey">) {}

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | boolean | undefined>; body?: Json } = {},
  ): Promise<T> {
    const url = new URL(`${this.connection.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        "X-N8N-API-KEY": this.connection.apiKey,
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new N8nApiError(
        response.status,
        text,
        `n8n ${method} ${path} failed with ${response.status}: ${text.slice(0, 1000)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  listWorkflows(query: ListQuery): Promise<{ data: N8nWorkflow[]; nextCursor?: string | null }> {
    return this.request("GET", "/workflows", {
      query: { ...query, excludePinnedData: true },
    });
  }

  getWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request("GET", `/workflows/${encodeURIComponent(id)}`, {
      query: { excludePinnedData: true },
    });
  }

  createWorkflow(workflow: JsonObject): Promise<N8nWorkflow> {
    return this.request("POST", "/workflows", { body: toCreateBody(workflow) });
  }

  updateWorkflow(id: string, workflow: JsonObject, publishIfActive?: boolean): Promise<N8nWorkflow> {
    return this.request("PUT", `/workflows/${encodeURIComponent(id)}`, {
      query: { publishIfActive },
      body: toUpdateBody(workflow),
    });
  }

  activateWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request("POST", `/workflows/${encodeURIComponent(id)}/activate`);
  }

  deactivateWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request("POST", `/workflows/${encodeURIComponent(id)}/deactivate`);
  }

  archiveWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request("POST", `/workflows/${encodeURIComponent(id)}/archive`);
  }

  unarchiveWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request("POST", `/workflows/${encodeURIComponent(id)}/unarchive`);
  }

  deleteWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request("DELETE", `/workflows/${encodeURIComponent(id)}`);
  }

  getWorkflowTags(id: string): Promise<{ id: string; name: string }[]> {
    return this.request("GET", `/workflows/${encodeURIComponent(id)}/tags`);
  }

  setWorkflowTags(id: string, tagIds: string[]): Promise<{ id: string; name: string }[]> {
    return this.request("PUT", `/workflows/${encodeURIComponent(id)}/tags`, {
      body: tagIds.map((tagId) => ({ id: tagId })),
    });
  }
}
