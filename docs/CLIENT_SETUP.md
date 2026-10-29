# Client Setup Guide

Each of the 8 supported AI clients connects to the same MCP server over stdio. The config snippets differ only in the file format (JSON vs TOML vs JSONC) and the location of the config file.

This guide assumes you've already run `npm install && npm run build` in the project root so `dist/index.js` exists.

> **Start here instead if you want the guided path:** [`GETTING-STARTED.md`](./GETTING-STARTED.md) covers prerequisites, both installers (`scripts/install-windows.ps1`, `scripts/install-unix.sh`), the runtime contract, and a troubleshooting table. This page is the per-client reference for wiring things up by hand.

## 1. Cursor

Cursor reads MCP config from:

- **Project**: `.cursor/mcp.json` in the project root
- **Global**: `%USERPROFILE%\.cursor\mcp.json` (Windows) / `~/.cursor/mcp.json` (macOS/Linux)

Copy `configs/cursor-mcp.json` to one of those locations, replacing `YOUR_USERNAME` with your Windows username.

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\mcp-video-editor\\dist\\index.js"],
      "env": {
        "MCP_VIDEO_BACKUP_DIR": "C:\\Users\\YOUR_USERNAME\\.mcp-video-editor\\backups",
        "MCP_VIDEO_EXPORT_DIR": "C:\\Users\\YOUR_USERNAME\\Videos\\mcp-video-editor",
        "OPENCUT_PROJECTS_DIR": "C:\\Users\\YOUR_USERNAME\\Documents\\OpenCut\\projects"
      }
    }
  }
}
```

After saving, run `Cmd/Ctrl+Shift+P → "Reload Window"` in Cursor. Switch the chat to **Agent mode** — MCP tools are only available in Agent mode (not Ask or Edit).

## 2. Claude Desktop

Claude Desktop reads MCP config from:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Copy `configs/claude-desktop-config.json` there, replacing `YOUR_USERNAME`.

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\mcp-video-editor\\dist\\index.js"],
      "env": { ... }
    }
  }
}
```

After saving, fully quit Claude Desktop (right-click → Quit) and reopen. The MCP server should appear under Settings → Developer.

## 3. Codex CLI

Codex CLI reads MCP config from:

- **Global**: `%USERPROFILE%\.codex\config.toml` (Windows) / `~/.codex/config.toml` (macOS/Linux)
- Override the home dir with `CODEX_HOME=/path/to/dir`

TOML format — one `[mcp_servers.<name>]` table per server. If your `config.toml` already has other MCP servers defined, append (don't overwrite). The install script handles this for you; manually you'd add:

```toml
[mcp_servers.video-editor]
command = "node"
args = ["C:\\Users\\YOUR_USERNAME\\mcp-video-editor\\dist\\index.js"]

[mcp_servers.video-editor.env]
MCP_VIDEO_BACKUP_DIR = "C:\\Users\\YOUR_USERNAME\\.mcp-video-editor\\backups"
MCP_VIDEO_EXPORT_DIR = "C:\\Users\\YOUR_USERNAME\\Videos\\mcp-video-editor"
OPENCUT_PROJECTS_DIR = "C:\\Users\\YOUR_USERNAME\\Documents\\OpenCut\\projects"
```

After saving, run `/mcp` in the Codex TUI to confirm `video-editor` is registered.

## 4. Antigravity

Antigravity (Google's Gemini-based IDE) reads MCP config from:

- **Global**: `%USERPROFILE%\.gemini\config\mcp_config.json` (Windows) / `~/.gemini/config/mcp_config.json` (macOS/Linux)
- **Workspace**: `.agents/mcp_config.json` in the project root

The Antigravity schema does **not** accept a `type` field for stdio servers — just `command`, `args`, `env`. Copy `configs/antigravity-mcp_config.json`:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\mcp-video-editor\\dist\\index.js"],
      "env": { ... },
      "timeoutSeconds": 60
    }
  }
}
```

Tip from Google's own forum: Antigravity launched from the GUI doesn't always inherit your shell's PATH. If you get "executable not found", use the **absolute** path to `node.exe` (e.g. `C:\\Program Files\\nodejs\\node.exe`).

## 5. OpenCode

OpenCode reads MCP config from:

- **Global**: `%USERPROFILE%\.config\opencode\opencode.json` (Windows) / `~/.config/opencode/opencode.json` (macOS/Linux)
- **Project**: `opencode.json` in the project root

OpenCode's schema differs from Cursor/Claude — it uses the **`mcp`** key (not `mcpServers`) and **`command` is an array** that includes args:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "video-editor": {
      "type": "local",
      "command": [
        "node",
        "C:\\Users\\YOUR_USERNAME\\mcp-video-editor\\dist\\index.js"
      ],
      "enabled": true,
      "timeout": 60000,
      "environment": {
        "MCP_VIDEO_BACKUP_DIR": "C:\\Users\\YOUR_USERNAME\\.mcp-video-editor\\backups",
        "MCP_VIDEO_EXPORT_DIR": "C:\\Users\\YOUR_USERNAME\\Videos\\mcp-video-editor",
        "OPENCUT_PROJECTS_DIR": "C:\\Users\\YOUR_USERNAME\\Documents\\OpenCut\\projects"
      }
    }
  }
}
```

Note: OpenCode uses `environment` (not `env`) for the env-var map. After saving, restart OpenCode.

## 6. KiloCode

KiloCode (the VS Code extension by Anaconda) reads MCP config from:

- **Global**: `%USERPROFILE%\.config\kilo\kilo.jsonc` (Windows) / `~/.config/kilo/kilo.jsonc` (macOS/Linux)
- **Project**: `kilo.jsonc` in the project root (or `.kilo/kilo.jsonc`)

Kilo uses JSONC (comments allowed) with the standard `mcpServers` shape plus a few Kilo-specific fields:

```jsonc
{
  "$schema": "https://kilo.ai/kilo.schema.json",
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\mcp-video-editor\\dist\\index.js"],
      "env": { ... },
      "disabled": false,
      "alwaysAllow": [],  // pre-approve tool names to skip prompts
      "timeout": 60       // seconds
    }
  }
}
```

To skip the per-tool-call approval prompt, add tool names to `alwaysAllow` (e.g. `["list_projects", "get_project_state", "get_timeline"]` for read-only tools).

## 7. Qwen Code

Qwen Code (the Alibaba CLI, a Gemini CLI fork) reads MCP config from `~/.qwen/settings.json` on macOS/Linux or `%USERPROFILE%\.qwen\settings.json` on Windows.

The file uses the Gemini-style `mcpServers` key:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
      "env": {
        "MCP_VIDEO_BACKUP_DIR": "/home/you/.mcp-video-editor/backups"
      },
      "timeout": 60000
    }
  }
}
```

That file holds other Qwen settings too, so merge the `mcpServers` block rather than overwriting it. The CLI can do the merge itself:

```bash
qwen mcp add -s user -t stdio video-editor node /absolute/path/to/mcp-video-editor/dist/index.js
qwen mcp list          # video-editor should appear
```

Use `-e KEY=value` for env vars and `--trust` to skip tool-call confirmation in a trusted workspace.

## 8. ZCode CLI

ZCode CLI reads MCP config from the `setting.json` in its CLI directory — `~/.zcode/cli/setting.json` (`%USERPROFILE%\.zcode\cli\setting.json` on Windows).

Servers live under the top-level `mcp.servers` object, and `features.mcp` must be `true`:

```json
{
  "features": { "mcp": true },
  "mcp": {
    "servers": {
      "video-editor": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
        "env": { "MCP_VIDEO_BACKUP_DIR": "/home/you/.mcp-video-editor/backups" },
        "timeoutMs": 60000
      }
    }
  }
}
```

Merge this into your existing `setting.json` — it also holds `permission`, `plugins` and `hooks`. Use `timeoutMs` (not `timeout`). Restart ZCode afterwards; the runtime reads the file once at startup. Provider/model settings are separate, in `~/.zcode/v2/provider_config.json`.

## Verifying the connection

After wiring up any client, restart it and try one of:

- **Cursor**: in Agent mode, ask Cursor "List my CapCut projects".
- **Claude Desktop**: type "Use the video-editor MCP server to list my CapCut projects".
- **Codex CLI**: run `/mcp` then in chat "list_projects with editor=capcut".
- **Antigravity**: open the MCP store, the `video-editor` server should show "Connected".
- **OpenCode**: `opencode mcp list` should show `video-editor`.
- **KiloCode**: the MCP panel should show a green dot next to `video-editor`.
- **Qwen Code**: `qwen mcp list` should list `video-editor` as connected.
- **ZCode CLI**: ask it to run `list_projects`; a refused/unknown-tool reply means `features.mcp` or `mcp.servers` didn't load.

If any client shows "Failed to connect":

1. Confirm `node` is on your PATH: `node --version` should print v18 or later.
2. Confirm `dist/index.js` exists at the path you put in the config.
3. Try running the server directly: `node C:\path\to\dist\index.js` — it should sit waiting on stdin. Ctrl+C to exit.
4. Check the client's logs (most clients log MCP server stderr to a file like `~/.cursor/logs/mcp.log`).

## The one runtime rule worth repeating

Close CapCut before a physical write (`save_project` or any mutation with `dryRun: false`). CapCut holds handles on its draft folder while running; the server retries `EBUSY` three times with backoff, but a save that lands mid-render can still fail. Dry-run calls are unaffected — they never touch disk.

Give each client a generous timeout too. A large timeline serializes and writes in one shot, and on Windows a retry can push a save past a short client default — 60s is a sane floor.

## Multiple clients on the same machine

The MCP server is stateless per-connection — each client spawns its own instance. Two clients can run simultaneously without interfering. The in-memory project cache is per-process; the on-disk draft is shared. To avoid two clients racing on `save_project`, only have one client editing a given draft at a time.

## Uninstall

```bash
# Remove the project
rm -rf ~/mcp-video-editor

# Remove client config entries (Cursor example)
# Edit ~/.cursor/mcp.json and delete the "video-editor" key

# Backups are never auto-deleted; remove manually:
rm -rf ~/.mcp-video-editor
```
