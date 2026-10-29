# Getting Started

This guide takes you from a clean machine to an AI client that can edit a real CapCut or OpenCut timeline. It covers Windows (PowerShell) and macOS/Linux (Bash), the automated installer, manual registration for all 8 supported clients, and the constraints that keep your drafts safe.

Reading time: about 10 minutes. Hands-on time: about 5.

---

## 1. What you need

| Requirement | Notes |
|---|---|
| **Node.js 18 or newer** | `node -v` must print `v18.x` or higher. Node 20+ recommended. |
| **npm** | Ships with Node. |
| **CapCut desktop** (optional) | Needed only if you want to edit CapCut drafts. Drafts live under `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\`. |
| **OpenCut** (optional) | Needed only for OpenCut projects. Default project folder is `~/Documents/OpenCut/projects`. |
| **An MCP-capable AI client** | Cursor, Claude Desktop, Codex CLI, Antigravity, OpenCode, KiloCode, Qwen Code, or ZCode. |

You do **not** need CapCut or OpenCut installed to run the server or its tests. Editing CapCut drafts does require the CapCut folder layout to exist on disk.

---

## 2. Install

### Windows (PowerShell)

```powershell
git clone https://github.com/AISEO-VirtualabDigital/mcp-video-editor.git "$env:USERPROFILE\mcp-video-editor"
cd "$env:USERPROFILE\mcp-video-editor"
npm install
npm run build
```

If PowerShell blocks the installer script with an execution-policy error:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### macOS / Linux / WSL

```bash
git clone https://github.com/AISEO-VirtualabDigital/mcp-video-editor.git ~/mcp-video-editor
cd ~/mcp-video-editor
npm install
npm run build
```

Sanity check before touching any client config — this must exit 0:

```bash
node -e "console.log(require('node:fs').existsSync('dist/index.js') ? 'dist OK' : 'MISSING dist/index.js')"
```

---

## 3. Run the installer (recommended)

The installer builds the project, creates the data folders, writes a config for each client it can safely own, and then probes that the server boots.

**Windows**

```powershell
pwsh -File scripts\install-windows.ps1
```

**macOS / Linux**

```bash
bash scripts/install-unix.sh
```

Useful flags (both scripts):

| Flag | Effect |
|---|---|
| `--skip-build` / `-SkipBuild` | Reuse the existing `dist/`, skip `npm install` and `npm run build`. |
| `--clients cursor,claude` / `-Clients "cursor,claude"` | Install for a subset only. |

What it writes:

| Client | Config file | Written? |
|---|---|---|
| Cursor | `~/.cursor/mcp.json` | Yes |
| Claude Desktop | `~/.config/Claude/claude_desktop_config.json` (Linux), `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | Yes |
| Codex CLI | `~/.codex/config.toml` | Yes — appended, not overwritten |
| Antigravity | `~/.gemini/config/mcp_config.json` | Yes |
| OpenCode | `~/.config/opencode/opencode.json` | Yes |
| KiloCode | `~/.config/kilo/kilo.jsonc` | Yes |
| Qwen Code | `~/.qwen/settings.json` | **No** — printed as a manual merge |
| ZCode | `~/.zcode/cli/setting.json` | **No** — printed as a manual merge |

Qwen Code and ZCode are skipped on purpose: those files hold unrelated user settings and overwriting them would destroy your configuration. The installer prints the merge target; section 5 shows the exact snippet.

Any config file that already exists is copied to `<file>.bak.<timestamp>` before being replaced. Nothing is deleted.

> **Windows caveat:** `install-windows.ps1` is untested on a Windows host by the maintainer — the Unix script and the manual configs below are the verified paths. If the PowerShell script misbehaves, use section 5.

---

## 4. Verify it works

Restart your AI client, then in a chat:

```text
List my OpenCut projects.
```

That maps to the `list_projects` tool with `editor: "opencut"`. A working install answers with project names, ids, and durations, or `Found 0 opencut project(s).` if the folder is empty.

Then create a throwaway project and add a clip:

```text
Create an OpenCut project called "Smoke Test" (dryRun false), open it, add a 6 second video track, and add the clip at /path/to/clip.mp4.
```

If tools appear in the client but every call fails, jump to section 8.

---

## 5. Manual client registration

Use this when the installer is unavailable or you want to control the config by hand. Every client launches the same command:

```
node /absolute/path/to/mcp-video-editor/dist/index.js
```

Use absolute paths. Relative paths resolve against whatever directory the client happens to launch from, which is rarely your project root.

### Cursor

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a project.

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
      "env": {
        "MCP_VIDEO_BACKUP_DIR": "/home/you/.mcp-video-editor/backups",
        "MCP_VIDEO_EXPORT_DIR": "/home/you/Videos/mcp-video-editor",
        "OPENCUT_PROJECTS_DIR": "/home/you/Documents/OpenCut/projects"
      }
    }
  }
}
```

On Windows, escape backslashes: `"args": ["C:\\Users\\you\\mcp-video-editor\\dist\\index.js"]`.

Then reload the window. MCP tools are only offered in **Agent** mode — Ask and Edit modes will not show them.

### Claude Desktop

File:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
      "env": {
        "MCP_VIDEO_BACKUP_DIR": "/home/you/.mcp-video-editor/backups",
        "MCP_VIDEO_EXPORT_DIR": "/home/you/Videos/mcp-video-editor",
        "OPENCUT_PROJECTS_DIR": "/home/you/Documents/OpenCut/projects"
      }
    }
  }
}
```

Claude Desktop only reads this file at startup. Fully quit the app (tray icon → Quit, not just close the window) and relaunch. The server then appears under Settings → Developer.

### Qwen Code

Qwen reads `~/.qwen/settings.json`, which also holds unrelated settings, so merge the `mcpServers` key instead of replacing the file:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
      "env": {
        "MCP_VIDEO_BACKUP_DIR": "/home/you/.mcp-video-editor/backups",
        "MCP_VIDEO_EXPORT_DIR": "/home/you/Videos/mcp-video-editor",
        "OPENCUT_PROJECTS_DIR": "/home/you/Documents/OpenCut/projects"
      },
      "timeout": 60000
    }
  }
}
```

The 60s timeout matters: CapCut file writes retry on Windows folder locks, so a large `save_project` can outlive a short client default.

### Codex CLI

File: `~/.codex/config.toml`. Append — do not replace the file if other servers are already defined.

```toml
[mcp_servers.video-editor]
command = "node"
args = ["/absolute/path/to/mcp-video-editor/dist/index.js"]

[mcp_servers.video-editor.env]
MCP_VIDEO_BACKUP_DIR = "/home/you/.mcp-video-editor/backups"
MCP_VIDEO_EXPORT_DIR = "/home/you/Videos/mcp-video-editor"
OPENCUT_PROJECTS_DIR = "/home/you/Documents/OpenCut/projects"
```

Verify with `/mcp` inside the Codex TUI.

### Antigravity

File: `~/.gemini/config/mcp_config.json`. Same JSON shape as Cursor:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
      "env": {
        "OPENCUT_PROJECTS_DIR": "/home/you/Documents/OpenCut/projects"
      }
    }
  }
}
```

### OpenCode

File: `~/.config/opencode/opencode.json`. OpenCode uses its own `mcp` block:

```json
{
  "mcp": {
    "video-editor": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcp-video-editor/dist/index.js"],
      "enabled": true,
      "timeout": 60000,
      "environment": {
        "OPENCUT_PROJECTS_DIR": "/home/you/Documents/OpenCut/projects"
      }
    }
  }
}
```

### KiloCode

File: `~/.config/kilo/kilo.jsonc`. JSONC allows comments:

```jsonc
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
      // Keep this generous: Windows file locks can make a save retry.
      "timeout": 60000
    }
  }
}
```

### ZCode

File: `~/.zcode/cli/setting.json`. Merge the `mcpServers` key into the existing object:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-editor/dist/index.js"],
      "env": {
        "OPENCUT_PROJECTS_DIR": "/home/you/Documents/OpenCut/projects"
      }
    }
  }
}
```

### If a client shows no tools

Client config schemas drift between versions. Before assuming the server is broken, check that the client still expects `mcpServers` and not `servers` (VS Code-based MCP hosts use the latter), and that the file you edited is the one the client actually loads — several clients have both a global and a per-project config, and the per-project one wins.

---

## 6. How it behaves under the hood

Knowing these five rules removes almost all surprise.

**1. Projects are cached in memory and must be opened first.** `open_project` reads the file and caches the normalized project per connection. Mutations act on that cache. `save_project` (or any mutation with `dryRun: false`) writes the cache to disk. Tools called on a project that was never opened fail with `Project <id> is not open. Call open_project first.` — that is a guard, not a bug.

**2. Dry-run is the default.** Every mutating tool takes `dryRun`, defaulting to `true`. In dry-run the in-memory cache *does* update, so you can inspect the proposed result with `get_timeline` / `get_project_state`, but nothing is written. To actually persist, pass `dryRun: false` explicitly. Preview snapshots of dry-run state used to be cached to disk on every call; that is now opt-in via `MCP_VIDEO_DRY_RUN_SNAPSHOT=1`, because a 20 MB timeline was being serialized twice per edit for no extra information.

**3. CapCut must be closed during a physical write.** CapCut holds handles on its draft folder while it is running. A write that lands mid-lock surfaces as `EBUSY`, which the server retries with backoff (3 attempts). If CapCut is actively rendering, even the retries can lose: close CapCut, or accept the failed write and retry. The lock window is deliberately minimal — the payload is serialized once, written to a temp file, and only the final `rename` touches the real `draft_content.json`.

**4. Nothing is overwritten without a backup, and backups are never pruned.** Before any physical write the previous file (or draft folder) is copied to `~/.mcp-video-editor/backups/<YYYY-MM-DD>/<HHmmss>__<name>.<rand>.bak`. That directory only grows; deleting old backups is your call.

**5. Every path is confined.** Project ids must match `[A-Za-z0-9_.-]+` and cannot start with a dot. Source media paths, export paths, and resolved project paths are checked for containment inside their expected root after resolution, so `../../etc/passwd` or `C:\Windows\...` as an export target is refused before any filesystem call. Symlinks are refused for JSON reads and as media sources — a planted symlink could otherwise point outside the sandbox. JSON files above 50 MiB are rejected rather than parsed.

Additionally: unmodelled vendor fields survive a round-trip. CapCut and OpenCut both carry keys this server does not model; those are preserved verbatim through read → mutate → write instead of being dropped.

---

## 7. Environment variables

All optional. Defaults are per-user and portable.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_VIDEO_BACKUP_DIR` | `~/.mcp-video-editor/backups` | Where pre-write backups go. |
| `MCP_VIDEO_EXPORT_DIR` | `~/Videos/mcp-video-editor` | Default root for `export_timeline_xml` output. |
| `MCP_VIDEO_CACHE_DIR` | `~/.mcp-video-editor/cache` | Dry-run preview snapshots (only used when snapshots are enabled). |
| `MCP_VIDEO_DRY_RUN_SNAPSHOT` | unset (off) | Set to `1` to cache a JSON snapshot of each dry-run result. |
| `OPENCUT_PROJECTS_DIR` | `~/Documents/OpenCut/projects` | Where OpenCut project JSON lives. |
| `LOCALAPPDATA` | platform default | Windows only — base for the CapCut drafts root. |

Set these in the `env` block of the client config, not in your shell profile. The client process is what launches the server, and it does not inherit your interactive shell.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `video-editor` tools in the client | Config path wrong, `node` not on PATH, or wrong key name | Run `node /absolute/path/dist/index.js` by hand; if it starts, the config file is the problem. Try `servers` instead of `mcpServers`. |
| `Cannot find module .../dist/index.js` | Build never ran | `npm install && npm run build`, confirm `dist/index.js` exists. |
| `Project <id> is not open` | `open_project` not called in this session | Call `open_project` first; the cache is per connection. |
| `EBUSY ...` on save | CapCut is open and holding the draft folder | Close CapCut, then retry the write. |
| `OpenCut project not found` | Wrong `OPENCUT_PROJECTS_DIR`, or the id belongs to CapCut | Check the path in the config matches where OpenCut actually stores projects. |
| `Source file not found` / `Unsafe source path` | Media path is relative, outside the allowed roots, or a symlink | Pass an absolute path to a real file. |
| `Path escape detected` on export | `outputPath` resolves outside `MCP_VIDEO_EXPORT_DIR` | Write inside the export root, or change the root. |
| Tools work, writes silently do nothing | `dryRun` left at its default | Pass `dryRun: false`. |
| Claude Desktop shows no server | App was closed, not quit | Tray → Quit, relaunch. |
| `export_timeline_xml` output will not import cleanly | Premiere/Filmora import is BETA and untested by the maintainer | Treat the XML as a starting point and relink media manually. |

Want proof the install is healthy without involving a client? Run the bundled smoke test from the project root:

```bash
npm run smoke
```

It boots the server in a throwaway sandbox and asserts 25 behaviours — every mutating path, the dry-run guarantee, the path guards, and the vendor-field round-trip. `npm run verify` runs the typecheck first, then the smoke test.

---

## 9. Where to go next

- `docs/TOOLS.md` — all 59 tools with inputs and honest notes on what is experimental.
- `docs/ARCHITECTURE.md` — how the adapter layer, safety layer, and project cache fit together.
- `docs/SECURITY.md` — the threat model behind the path guards and backup policy.
- `docs/CLIENT_SETUP.md` — per-client config details, one page each.

Try a real edit: open a project, list its tracks, split a clip at the playhead, add a text overlay, then `save_project` with `dryRun: false` — and check `~/.mcp-video-editor/backups/` for the timestamped copy of what was there before.
