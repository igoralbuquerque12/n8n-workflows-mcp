export type Access = "read" | "confirm" | "write";

export interface Config {
  baseUrl: string;
  apiKey: string;
  access: Access;
  protectedNames: RegExp | null;
  blockProtected: boolean;
  backupDir: string | null;
}

function parseAccess(raw: string | undefined): Access {
  if (raw === undefined || raw === "") return "write";
  if (raw === "read" || raw === "confirm" || raw === "write") return raw;
  throw new Error(`Invalid N8N_ACCESS "${raw}" (expected read, confirm or write)`);
}

function parseBoolean(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Invalid ${name} "${raw}" (expected true or false)`);
}

// Each term matches as a whole word, so "prod" matches "Pillot AI - Prod" but not "Product sync".
function parseProtectedNames(raw: string | undefined): RegExp | null {
  const terms = (raw ?? "")
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term !== "");
  if (terms.length === 0) return null;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.N8N_URL;
  const apiKey = env.N8N_API_KEY;
  if (!url || !apiKey) {
    throw new Error("Missing configuration. Set both N8N_URL and N8N_API_KEY.");
  }

  // Fail instead of ignoring the removed variable, so an old .env never silently drops its protection.
  if (env.N8N_PROTECTED_NAME_PATTERN) {
    throw new Error("N8N_PROTECTED_NAME_PATTERN was removed. Use N8N_PROTECTED_NAMES (comma-separated words, e.g. production,prod).");
  }
  const protectedNames = parseProtectedNames(env.N8N_PROTECTED_NAMES);
  const blockProtected = parseBoolean("N8N_BLOCK_PROTECTED", env.N8N_BLOCK_PROTECTED);
  if (blockProtected && !protectedNames) {
    throw new Error("N8N_BLOCK_PROTECTED=true needs N8N_PROTECTED_NAMES.");
  }

  return {
    baseUrl: url.replace(/\/+$/, ""),
    apiKey,
    access: parseAccess(env.N8N_ACCESS),
    protectedNames,
    blockProtected,
    backupDir: env.N8N_BACKUP_DIR || null,
  };
}
