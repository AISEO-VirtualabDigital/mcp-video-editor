# mcp-video-editor

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI coding assistants edit videos in **CapCut** and **OpenCut**.

Connects to **Cursor**, **Claude Desktop**, **Codex CLI**, **Antigravity**, **OpenCode**, and **KiloCode** over stdio.

## What it does

| Capability | Tools | CapCut | OpenCut |
| --- | --- | --- | --- |
| Project management | `list_projects`, `create_project`, `open_project`, `close_project`, `save_project`, `duplicate_project`, `delete_project` | ✅ | ✅ |
| Timeline & clips | `add_track`, `remove_track`, `add_clip`, `add_video_clip`, `split_clip`, `trim_clip`, `move_clip`, `delete_clip`, `set_clip_speed`, `set_track_volume`, `set_track_visibility` | ✅ | ✅ |
| Text & captions | `add_text`, `update_text`, `delete_text`, `set_text_style`, `set_text_position` | ✅ | ✅ |
| Transitions / effects | `add_transition`, `remove_transition`, `add_filter`, `add_effect`, `remove_effect`, `add_sticker`, `add_animation` | ✅ | ✅ |
| Audio | `add_audio_clip`, `adjust_volume`, `adjust_track_volume`, `fade_in`, `fade_out`, `split_audio`, `denoise` | ✅ | ✅ |
| Export & render | `list_export_profiles`, `set_export_params`, `export_project`, `get_render_status`, `list_render_tasks` | ✅ | ✅ |
| Inspect / query | `get_project_state`, `get_timeline`, `get_clips`, `get_track_info`, `get_materials`, `get_texts`, `get_effects`, `get_open_project_ids` | ✅ | ✅ |

**50 tools total**, all of which honor `dryRun: true` by default (the safe setting).

## How it works

```
┌──────────────────────────────────────────────────────────────────────────┐
│ AI Client (Cursor / Claude / Codex / Antigravity / OpenCode / KiloCode)  │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ JSON-RPC 2.0 over stdio (MCP)
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ mcp-video-editor (this server, Node.js)                                  │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐  │
│   │ 50 MCP tools │ → │ adapters/   │ → │ safety/     │ → │ utils/      │  │
│   │ project,     │   │ capcut.ts   │   │ backup.ts   │   │ paths.ts    │  │
│   │ timeline,    │   │ opencut.ts  │   │ validator.ts│   │ fs.ts       │  │
│   │ text, ...    │   │ facade.ts  │   │ dry-run.ts  │   │ id.ts       │  │
│   └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘  │
└──────────────┬───────────────────────────────────────────────────┬───────┘
               ▼                                                   ▼
   %LOCALAPPDATA%\CapCut\User Data\             %USERPROFILE%\Documents\OpenCut\projects\
   Projects\com.lveditor.draft\<id>\                       <id>.json
   draft_content.json
```

The server normalizes both CapCut drafts and OpenCut projects into a single `EditorProject` shape, mutates it in memory, and writes back via the editor-specific adapter. Unknown vendor fields round-trip through `raw` so nothing is lost on save.

## Safety rails

- **Dry-run by default.** Every write tool takes `dryRun: true` unless you pass `dryRun: false`. The in-memory cache is mutated so the AI can immediately query the new state, but no file is touched.
- **Backups before writes.** When `dryRun=false`, the target file is copied to `~/.mcp-video-editor/backups/<date>/<timestamp>__<filename>.<rand>.bak` before overwrite. Backups are never auto-deleted.
- **Schema validation.** Reads validate the vendor file shape; writes validate the normalized project (clip overlap, dangling material references, negative durations, etc.) and refuse on violation.
- **Destructive ops require explicit confirmation.** `delete_project` requires `confirm: true` or it refuses.
- **Atomic writes.** All disk writes go through `tmp file + rename` so a crashed write never leaves a half-written draft.

## Quick start (Windows)

```powershell
# 1. Clone or copy this folder somewhere, e.g. C:\Users\you\mcp-video-editor
cd C:\Users\you\mcp-video-editor

# 2. Install + build
npm install
npm run build

# 3. Run the installer — it writes configs into all 6 AI clients
pwsh -File scripts/install-windows.ps1
# Or install for just Cursor + Claude:
pwsh -File scripts/install-windows.ps1 -Clients "cursor,claude"
```

Then restart each AI client. You'll see `video-editor` listed in the client's MCP panel.

## Quick start (macOS / Linux / WSL)

```bash
cd ~/mcp-video-editor
npm install
npm run build
bash scripts/install-unix.sh
# Or: bash scripts/install-unix.sh --clients cursor,claude
```

## Manual client setup

If you'd rather wire up clients by hand, copy the relevant snippet from [`configs/`](./configs) into each client's expected config location:

| Client | Config path | Template |
| --- | --- | --- |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` | [`configs/cursor-mcp.json`](./configs/cursor-mcp.json) |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | [`configs/claude-desktop-config.json`](./configs/claude-desktop-config.json) |
| Codex CLI | `%USERPROFILE%\.codex\config.toml` | [`configs/codex-config.toml`](./configs/codex-config.toml) |
| Antigravity | `%USERPROFILE%\.gemini\config\mcp_config.json` | [`configs/antigravity-mcp_config.json`](./configs/antigravity-mcp_config.json) |
| OpenCode | `%USERPROFILE%\.config\opencode\opencode.json` | [`configs/opencode.json`](./configs/opencode.json) |
| KiloCode | `%USERPROFILE%\.config\kilo\kilo.jsonc` | [`configs/kilo-kilo.jsonc`](./configs/kilo-kilo.jsonc) |

Replace `YOUR_USERNAME` in the snippets with your Windows username (the installer does this for you).

## Environment variables

Override default locations if you keep your projects elsewhere.

| Variable | Default (Windows) | Purpose |
| --- | --- | --- |
| `MCP_VIDEO_BACKUP_DIR` | `%USERPROFILE%\.mcp-video-editor\backups` | Where backups live |
| `MCP_VIDEO_EXPORT_DIR` | `%USERPROFILE%\Videos\mcp-video-editor` | Where renders + task JSONs are written |
| `MCP_VIDEO_CACHE_DIR` | `%USERPROFILE%\.mcp-video-editor\cache` | Dry-run preview snapshots |
| `OPENCUT_PROJECTS_DIR` | `%USERPROFILE%\Documents\OpenCut\projects` | OpenCut project root |

## Sample conversation

After wiring up Cursor, in Agent mode:

> **You**: "Open my latest CapCut draft, add a 2-second text overlay saying 'Hello from Cursor' at the start, and save it."
>
> **Cursor** (calls `list_projects` → `open_project` → `add_text` → `save_project`):
> ✓ Opened CapCut project "My First Edit" (id=draft_abc123, duration=12_345_000us, 3 tracks, 8 materials).
> ✓ [DRY-RUN] Add text "Hello from Cursor". In-memory cache updated; NOT written to disk. Use save_project to persist.
> ✓ Would you like me to actually persist these changes? (Pass `dryRun: false`.)
>
> **You**: "Yes, persist it."
>
> **Cursor** (calls `save_project` with `dryRun: false`):
> ✓ Saved CapCut project "My First Edit" (3 tracks) to %LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\draft_abc123\draft_content.json (backup: %USERPROFILE%\.mcp-video-editor\backups\2026-10-26\...\draft_content.json.abc123.bak)

## Project layout

```
mcp-video-editor/
├── src/
│   ├── index.ts                 # Entry point
│   ├── server.ts                # MCP server setup + tool registration
│   ├── tools/                   # 50 tools across 7 categories
│   │   ├── index.ts              # Tool registry
│   │   ├── project.ts           # list/create/open/close/save/duplicate/delete
│   │   ├── timeline.ts          # tracks, clips, splits, trims, speed, volume, visibility
│   │   ├── text.ts              # text overlays, styling, positioning
│   │   ├── effects.ts           # transitions, filters, effects, stickers, animations
│   │   ├── audio.ts             # audio clips, fade in/out, denoise
│   │   ├── export.ts            # export profiles, render queue, status polling
│   │   └── inspect.ts           # read-only project state queries
│   ├── adapters/
│   │   ├── types.ts             # EditorProject normalized shape
│   │   ├── capcut.ts            # CapCut draft_content.json reader/writer
│   │   ├── opencut.ts           # OpenCut project JSON reader/writer
│   │   └── facade.ts            # Unified open/save/list/create
│   ├── safety/
│   │   ├── backup.ts            # Pre-write file backups
│   │   ├── validator.ts         # Schema validation
│   │   └── dry-run.ts           # Dry-run executor
│   ├── notifications/
│   │   └── events.ts            # Render + project-change event bus
│   └── utils/
│       ├── paths.ts             # Windows path resolution
│       ├── fs.ts                # Atomic JSON writes, retry-on-EBUSY
│       └── id.ts                # uid, time formatters
├── configs/                     # Client config snippets (one per AI client)
├── scripts/
│   ├── install-windows.ps1      # Windows installer
│   └── install-unix.sh          # macOS/Linux fallback
└── docs/
    ├── ARCHITECTURE.md
    ├── TOOLS.md
    └── CLIENT_SETUP.md
```

## Development

```bash
npm install          # install deps
npm run build        # tsc -> dist/
npm run typecheck    # tsc --noEmit
npm run dev          # run via tsx (no build step)
npm run inspect      # launch with MCP inspector (requires npx mcp-inspector)
```

Smoke-test the server locally:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}' \
  | node dist/index.js
```

You should see a JSON-RPC response with `serverInfo: { name: "mcp-video-editor", version: "1.0.0" }`.

## Limitations & notes

- **CapCut has no official API.** This server reads/writes CapCut's `draft_content.json` directly. CapCut must be **closed** (or at least not actively editing the same draft) when you call `save_project` with `dryRun: false`, otherwise the file may be locked — the server retries 3× on `EBUSY` but may still fail.
- **CapCut version drift.** CapCut changes its draft schema across versions. The adapter preserves unknown fields via `raw`, so round-tripping older drafts is generally safe, but new CapCut-only fields may be ignored on write.
- **OpenCut schema.** OpenCut's project format is still evolving. The adapter tolerates both flat `tracks` and nested `timeline.tracks` shapes; the writer always emits the flat form (OpenCut ≥ 0.5).
- **Export is not actually rendering.** `export_project` writes an export task JSON and emits `renderProgress` notifications, but the actual MP4 render must be triggered by opening the draft in CapCut and pressing Export (CapCut will pick up the latest draft). For OpenCut, if a local OpenCut dev server is running on a known port, you can extend `tools/export.ts` to POST to its `/api/export` endpoint.
- **No UI automation.** If you need to drive CapCut's GUI (open menus, click filters), pair this server with a UI-automation layer (AutoHotkey on Windows).

## License

MIT
