# n8n-workflows-mcp

An MCP server (stdio) that lets Claude Code list, create and edit n8n workflows, and investigate their executions.
It talks to one n8n instance through the n8n public REST API (`/api/v1`).

## Requirements

- Node.js 20.6 or newer (needed for `node --env-file`)
- [Claude Code](https://code.claude.com)
- An n8n API key (see below)

## Setup

```bash
git clone <REPO_URL> n8n-workflows-mcp
cd n8n-workflows-mcp
npm install
npm run build
```

## Get your API key

1. Open n8n and go to **Settings -> n8n API**.
2. Click **Create API key** and copy it.

Each person uses their own key. Never share it and never commit it.

Tip: ask an admin for an n8n user that only belongs to the staging project. A key from that user cannot reach production workflows at all.

## Configure

Copy the example file and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `N8N_URL` | yes | Base URL of the n8n instance, e.g. `https://n8n.example.com`. Trailing slashes are removed. |
| `N8N_API_KEY` | yes | Your personal n8n API key. |
| `N8N_ACCESS` | no | `read` (no writes), `confirm` (every write needs `confirmProduction=true`) or `write`. Default: `write`. |
| `N8N_PROTECTED_NAMES` | no | Comma-separated words, e.g. `production,prod`. A workflow is protected when its name contains one of them as a whole word, in any case. `prod` matches `Pillot AI - Prod` but not `Product sync`. |
| `N8N_BLOCK_PROTECTED` | no | `true` hides protected workflows and blocks every read and write to them. `false` lets you change them with `confirmProduction=true`. Default: `false`. |
| `N8N_BACKUP_DIR` | no | Absolute folder where the previous JSON is saved before update, patch and delete. |

The server stops at startup if `N8N_URL` or `N8N_API_KEY` is missing, or if `N8N_BLOCK_PROTECTED=true` is set without `N8N_PROTECTED_NAMES`. It also stops if the old `N8N_PROTECTED_NAME_PATTERN` is still set; replace it with `N8N_PROTECTED_NAMES`.

### Windows PowerShell 5.1

`Copy-Item .env.example .env` is fine. If you write the file yourself, use `Set-Content -Encoding ascii`. `-Encoding utf8` adds a BOM that breaks the first variable.

```powershell
@'
N8N_URL=https://n8n.example.com
N8N_API_KEY=your-api-key-here
N8N_ACCESS=write
N8N_PROTECTED_NAMES=production,prod
N8N_BLOCK_PROTECTED=false
N8N_BACKUP_DIR=C:\Users\you\projetos\n8n-workflows-mcp\n8n-backups
'@ | Set-Content -Encoding ascii .env
```

## Register in Claude Code

Use absolute paths. `--env-file` keeps the key in `.env` instead of in the Claude Code config.

```bash
claude mcp add --scope user --transport stdio n8n-workflows -- node --env-file=<ABS_PATH>/.env <ABS_PATH>/dist/server.js
```

macOS / Linux:

```bash
claude mcp add --scope user --transport stdio n8n-workflows -- \
  node --env-file=/home/you/n8n-workflows-mcp/.env \
  /home/you/n8n-workflows-mcp/dist/server.js
```

Windows PowerShell:

```powershell
claude mcp add --scope user --transport stdio n8n-workflows -- `
  node --env-file=C:\Users\you\projetos\n8n-workflows-mcp\.env `
  C:\Users\you\projetos\n8n-workflows-mcp\dist\server.js
```

Check it:

```bash
claude mcp list
```

`n8n-workflows` should show as connected. Then start a new Claude Code session.

## Using it

Example prompts:

- "List my n8n workflows."
- "In the workflow `[Staging] Robo`, add a Set node after the Webhook node that sets `source` to `webhook`."
- "Dry-run renaming the node `Set` to `Prepare` in workflow `abc123` and show me the result without saving."

### Investigating executions

Describe what happened and let Claude dig through the execution history:

- "The customer 11 98888-7777 says they did not get the confirmation yesterday afternoon. Find out what happened in `[Staging] Atendimento`."
- "Which executions of workflow `abc123` failed today, and in which node?"
- "Compare execution 812 (failed) with the last successful one and tell me what was different."

A typical investigation: `n8n_search_executions` finds the executions that contain the value (phone, order id, e-mail, error text) in a time window, `n8n_get_execution` shows the path the execution took and what each node received and produced, and `n8n_get_workflow` explains the logic.

Notes:

- The n8n API has no date or content filter, so the search reads executions newest first and filters them in this server. Pass `workflowId` and a date range to keep it fast. Each call reads at most `scanLimit` executions (default 300); continue with the returned `nextCursor`.
- n8n only keeps executions that its save and prune settings keep (`EXECUTIONS_DATA_SAVE_ON_SUCCESS`, `EXECUTIONS_DATA_MAX_AGE`, and so on). An execution that was not saved cannot be found.
- Execution data often contains customer data. Matched snippets and node outputs are sent to the model. Long strings and arrays are trimmed, and binary files are replaced by their name, type and size.

## Tools

| Tool | What it does |
| --- | --- |
| `n8n_list_workflows` | List workflows (id, name, active, node count). |
| `n8n_get_workflow` | Get the full workflow JSON. |
| `n8n_create_workflow` | Create a workflow (created inactive). |
| `n8n_update_workflow` | Replace a whole workflow with new JSON. |
| `n8n_patch_workflow` | Apply operations (add/update/remove/rename node, connect, disconnect, setName, mergeSettings). |
| `n8n_set_workflow_active` | Activate or deactivate a workflow. |
| `n8n_set_workflow_archived` | Archive or unarchive a workflow. |
| `n8n_delete_workflow` | Permanently delete a workflow. |
| `n8n_list_executions` | One page of executions, newest first, with status, duration and (for errors) the failing node and message. |
| `n8n_get_execution` | One execution: the nodes that ran in order, where each input came from, the first items of each output, errors and stack. |
| `n8n_search_executions` | Find executions by date range and by a value in the node data or error messages. |
| `n8n_retry_execution` | Retry a failed execution (runs the workflow again, with its side effects). |

## Safety

- **Protected names.** A workflow is protected when its name contains a word from `N8N_PROTECTED_NAMES`. The check uses the current name and also the new name when a create, update or patch would rename a workflow into a protected one.
- **Two modes for protected workflows:**

  | `N8N_BLOCK_PROTECTED` | List / search | Get | Create / update / patch / activate / archive / delete / retry |
  | --- | --- | --- | --- |
  | `false` (default) | shown | allowed | only with `confirmProduction=true` |
  | `true` | hidden | blocked | blocked, even with `confirmProduction=true` |

  Executions follow the protection of their workflow. With `N8N_BLOCK_PROTECTED=true`, executions of a workflow that no longer exists are also hidden, because its name cannot be checked.

- **Access mode.** With `N8N_ACCESS=confirm`, every write needs `confirmProduction=true`. With `N8N_ACCESS=read`, all writes are blocked.
- **These are guards in this server, not n8n permissions.** Protection is based on the workflow name only, so a production workflow without a protected word in its name is not protected. The API key is the real boundary: anything your key can reach is reachable by other tools that use it. For a hard block, use a key from an n8n user that has no access to the production project.
- **Backups.** With `N8N_BACKUP_DIR` set, the current JSON is saved before every update, patch and delete.
- **Dry run.** `dryRun: true` on update and patch validates the change and shows the result without writing.

### Recommended Claude Code permissions

Let read tools run freely and make Claude ask before every write. Add this to your user settings file, `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`). Merge it with any `permissions` you already have.

```json
{
  "permissions": {
    "allow": [
      "mcp__n8n-workflows__n8n_list_workflows",
      "mcp__n8n-workflows__n8n_get_workflow",
      "mcp__n8n-workflows__n8n_list_executions",
      "mcp__n8n-workflows__n8n_get_execution",
      "mcp__n8n-workflows__n8n_search_executions"
    ],
    "ask": [
      "mcp__n8n-workflows__n8n_create_workflow",
      "mcp__n8n-workflows__n8n_update_workflow",
      "mcp__n8n-workflows__n8n_patch_workflow",
      "mcp__n8n-workflows__n8n_set_workflow_active",
      "mcp__n8n-workflows__n8n_set_workflow_archived",
      "mcp__n8n-workflows__n8n_delete_workflow",
      "mcp__n8n-workflows__n8n_retry_execution"
    ]
  }
}
```

Permission rules match tool names, not arguments. A rule cannot tell a staging workflow from a production one. Rules are checked in the order deny, then ask, then allow. See the [Claude Code permissions docs](https://code.claude.com/docs/en/permissions).

## Troubleshooting

- **`CONNECTION_CLOSED` or "Failed to connect".** The path is wrong (it must be absolute) or the project is not built (`npm run build`). Run the same command by hand to see the error:
  ```bash
  node --env-file=<ABS_PATH>/.env <ABS_PATH>/dist/server.js
  ```
  If it starts and waits with no output, it works. Press Ctrl+C.
- **401.** The API key or `N8N_URL` is wrong. `N8N_URL` is the base URL, without `/api/v1`.
- **400 "must NOT have additional properties".** Your n8n version rejects a field the server sent. The n8n error message is returned in the tool result so you can see which field. The server already leaves these out of what it sends:
  - top-level fields whose value is `null` (the GET returns `description: null`, and the API rejects it);
  - the read-only settings `binaryMode`, `engineType` and `credentialResolverId`;
  - node keys outside the public API node schema (`id`, `name`, `type`, `typeVersion`, `position`, `parameters`, `credentials`, `webhookId`, `disabled`, `notes`, `notesInFlow`, `retryOnFail`, `maxTries`, `waitBetweenTries`, `alwaysOutputData`, `executeOnce`, `continueOnFail`, `onError`). An example is `rewireOutputLogTo`, which the editor adds to converted tool nodes. Update and patch report each dropped key in `warnings`, for example `node "Execute_Backend_Tool": dropped editor-only key rewireOutputLogTo`. Backups keep the full original JSON.
- **"Missing configuration" with a `.env` that looks right (Windows).** The file has a UTF-8 BOM. Rewrite it with `Set-Content -Encoding ascii` (see Configure).

## Updating

```bash
git pull
npm install
npm run build
```

Then start a new Claude Code session.
