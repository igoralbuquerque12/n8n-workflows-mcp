import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { N8nWorkflow } from "./n8nClient.js";

export class AccessBlockedError extends Error {}

export function isProtected(config: Config, workflowName: string): boolean {
  return config.protectedNames?.test(workflowName) ?? false;
}

export function assertReadAllowed(config: Config, workflowName: string): void {
  if (config.blockProtected && isProtected(config, workflowName)) {
    throw new AccessBlockedError(
      `Workflow "${workflowName}" is protected and N8N_BLOCK_PROTECTED=true: this server cannot read or change it.`,
    );
  }
}

export function assertWriteAllowed(config: Config, workflowName: string, confirmProduction: boolean | undefined): void {
  if (config.access === "read") {
    throw new AccessBlockedError("n8n access is read-only (N8N_ACCESS=read)");
  }

  assertReadAllowed(config, workflowName);
  const needsConfirmation = config.access === "confirm" || isProtected(config, workflowName);

  if (needsConfirmation && confirmProduction !== true) {
    throw new AccessBlockedError(
      `Write to "${workflowName}" needs explicit user approval. ` +
        "Show the user what will change, and only after they agree call again with confirmProduction=true.",
    );
  }
}

export async function backupWorkflow(config: Config, workflow: N8nWorkflow): Promise<string | null> {
  if (!config.backupDir) return null;
  await mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const file = path.join(config.backupDir, `${workflow.id}-${stamp}.json`);
  await writeFile(file, JSON.stringify(workflow, null, 2), "utf8");
  return file;
}
