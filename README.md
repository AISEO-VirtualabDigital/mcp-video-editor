# mcp-video-editor

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI coding assistants edit videos in **CapCut** and **OpenCut**.

Connects to **Cursor**, **Claude Desktop**, **Codex CLI**, **Antigravity**, **OpenCode**, **KiloCode**, **Qwen Code**, and **ZCode CLI** over stdio.

## What it does

| Capability | Tools | CapCut | OpenCut |
| --- | --- | --- | --- |
| Project management | `list_projects`, `create_project`, `open_project`, `close_project`, `save_project`, `duplicate_project`, `delete_project` | ✅ | ✅ |
| Timeline & clips | `add_track`, `remove_track`, `add_clip`, `add_video_clip`, `split_clip`, `trim_clip`, `move_clip`, `delete_clip`, `set_clip_speed`, `set_track_volume`, `set_track_visibility` | ✅ | ✅ |
| Text & captions | `add_text`, `update_text`, `delete_text`, `set_text_style`, `set_text_position` | ✅ | ✅ |
| Transitions / effects | `add_transition`, `remove_transition`, `add_filter`, `add_effect`, `remove_effect`, `add_sticker`, `add_animation` | ✅ | ✅ |
| Audio | `add_audio_clip`, `adjust_volume`, `adjust_track_volume`, `fade_in`, `fade_out`, `split_audio`, `denoise` | ✅ | ✅ |
| Export & render | `list_export_profiles`, `set_export_params`, `export_project`, `get_render_status`, `list_render_tasks` | ✅ | ✅ |
| Generation & rendering | `create_video`, `render_project` | ✅ | ✅ |
| Shot library | `list_shots`, `get_shot` | ✅ | ✅ |
| Voice synthesis | `generate_voice` | ✅ | ✅ |
| Effects catalog | `list_effects`, `get_effect`, `apply_face_effect` | ✅ | ✅ |
| Timeline exchange (beta) | `export_timeline_xml` | ⚠️ | ⚠️ |
| Inspect / query | `get_project_state`, `get_timeline`, `get_clips`, `get_track_info`, `get_materials`, `get_texts`, `get_effects`, `get_open_project_ids` | ✅ | ✅ |

**59 tools total**, all of which honor `dryRun: true` by default (the safe setting).

## Documentation

| Doc | What it covers |
| --- | --- |
| [Getting Started](./docs/GETTING-STARTED.md) | Install on Windows or Unix, both installers, manual registration for all 8 clients, the runtime contract, env vars, troubleshooting. **Start here.** |
| [Client Setup](./docs/CLIENT_SETUP.md) | Per-client reference: config paths, exact file formats (JSON / JSONC / TOML), verification commands. |
| [Tool Reference](./docs/TOOLS.md) | All 59 tools with arguments, returns, and notes on what is experimental. |
| [Architecture](./docs/ARCHITECTURE.md) | Read/write data flow, the normalized `EditorProject` shape, vendor-field preservation, safety guarantees, verification. |
| [Security](./docs/SECURITY.md) | Threat model, path guards, the refusal matrix, resolved findings, residual risks. |
| [Changelog](./CHANGELOG.md) | What changed in each version, including the honest notes on what is untested. |

## What's new

### 1.2.0 — write path, typing, onboarding

No new tools (still **59**). This release makes saves cheaper and types honest.

| Area | Change |
| --- | --- |
| CapCut writes | `material_type` resolves through one `Map` instead of a `find` per clip — O(clips + materials) instead of O(clips × materials) |
| Save path | Projects serialize **once**; an `EBUSY` retry re-runs only the file write, never `JSON.stringify` |
| Dry-run | Preview snapshots are opt-in (`MCP_VIDEO_DRY_RUN_SNAPSHOT=1`); each dry-run used to write a full copy of the project |
| OpenCut | Unmodelled vendor fields now round-trip at root/track/clip/material/text/effect level instead of being dropped |
| Types | New `src/adapters/raw.ts` guards; explicit casts 12 → 6, the two remaining are centralized vendor-root widenings |
| Tooling | `npm run smoke` (37 checks incl. the full path-guard matrix) and `npm run verify` (typecheck + smoke); new [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md) |

### 1.1.0 features

| Feature | Tools | Notes |
| --- | --- | --- |
| Effects catalog | `list_effects`, `get_effect`, `apply_face_effect` | 20 curated effects across face-tracked, kinetic-text, color-grade, motion, sticker and ambient categories, each tagged with `faceSafe` and a `timingHint`. `apply_face_effect` validates the id, rejects empty/inverted windows, and warns when an effect is not face-safe |
| Voice synthesis | `generate_voice` | MP3 voiceover via OpenAI (`tts-1`, `tts-1-hd`) or ElevenLabs (`eleven_multilingual_v2`), written under the export root |
| Motion render engine | `create_video`, `render_project` | Third engine alongside Remotion and HyperFrames; scaffolds a composition folder and renders through frame-stepping + ffmpeg |
| Shot library | `list_shots`, `get_shot` | Motion shot cards by category, for storyboard-style clip selection |
| New clients | — | Qwen Code and ZCode CLI configs added (`configs/qwen-config.json`, `configs/zcode-config.json`) |
| Premiere + Filmora export — **BETA, untested in-app** | `export_timeline_xml` | Writes FCP7 XML (xmeml v4), the exchange format Adobe Premiere and Wondershare Filmora both document. Nobody on this project owns either app, so a real import has never been run — treat it as experimental until someone confirms it in Premiere/Filmora |

Editor support is unchanged: **CapCut and OpenCut only**. Filmora and Adobe Premiere are not supported — see [Limitations & notes](#limitations--notes).

## How it works

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Client (Cursor / Claude / Codex / Antigravity / OpenCode / Kilo / Qwen / │
│ ZCode)                                                                   │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ JSON-RPC 2.0 over stdio (MCP)
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ mcp-video-editor (this server, Node.js)                                  │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐  │
│   │ 59 MCP tools │ → │ adapters/   │ → │ safety/     │ → │ utils/      │  │
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

- **Dry-run by default.** Every write tool takes `dryRun: true` unless you pass `dryRun: false`. Timeline/project edits update the in-memory cache so the AI can immediately query the new state, but do not write the editor project. Preview snapshots of dry-run state are off by default — set `MCP_VIDEO_DRY_RUN_SNAPSHOT=1` to cache them under `MCP_VIDEO_CACHE_DIR`.
- **Backups before writes and deletes.** When `dryRun=false`, an existing target is backed up before overwrite; `delete_project` backs up the entire project file/folder before removal. Backups are never auto-deleted.
- **Schema validation.** Reads validate the vendor file shape; writes validate the normalized project (clip overlap, dangling material references, negative durations, etc.) and refuse on violation.
- **Destructive ops require explicit confirmation.** `delete_project` requires `confirm: true` or it refuses.
- **Atomic writes.** All disk writes go through `tmp file + rename` so a crashed write never leaves a half-written draft. The payload is serialized once, the temp file is written through a single handle, and only the final rename touches `draft_content.json` — the narrowest lock window available, since CapCut's folder lock is the thing that produces `EBUSY`.
- **Close CapCut before a physical write.** CapCut holds handles on its draft folder while running. Writes retry on `EBUSY` with backoff, but a save that lands mid-render can still lose — close CapCut first.

## Quick start (Windows)

> New here? [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md) is the full walkthrough — prerequisites, both installers, manual registration for all 8 clients, and the safety constraints explained.

```powershell
# 1. Clone or copy this folder somewhere, e.g. C:\Users\you\mcp-video-editor
cd C:\Users\you\mcp-video-editor

# 2. Install + build
npm install
npm run build

# 3. Run the installer — it writes configs into all 6 JSON/TOML clients
#    (Qwen Code and ZCode are printed as manual-merge targets)
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
| Qwen Code | `%USERPROFILE%\.qwen\settings.json` | [`configs/qwen-config.json`](./configs/qwen-config.json) |
| ZCode CLI | `%USERPROFILE%\.zcode\cli\setting.json` | [`configs/zcode-config.json`](./configs/zcode-config.json) |

Qwen Code and ZCode keep other settings in those same files, so **merge** the `mcpServers` / `mcp.servers` block into the existing file instead of overwriting it. The installers skip both clients for that reason and print the merge target instead.

Replace `YOUR_USERNAME` in the snippets with your Windows username (the installer does this for you). The Qwen and ZCode snippets above are Windows-shaped; on macOS/Linux swap the `C:\\Users\\...` paths for real ones.

## Environment variables

Override default locations if you keep your projects elsewhere.

| Variable | Default (Windows) | Purpose |
| --- | --- | --- |
| `MCP_VIDEO_BACKUP_DIR` | `%USERPROFILE%\.mcp-video-editor\backups` | Where backups live |
| `MCP_VIDEO_EXPORT_DIR` | `%USERPROFILE%\Videos\mcp-video-editor` | Where renders + task JSONs are written |
| `MCP_VIDEO_CACHE_DIR` | `%USERPROFILE%\.mcp-video-editor\cache` | Dry-run preview snapshots |
| `OPENCUT_PROJECTS_DIR` | `%USERPROFILE%\Documents\OpenCut\projects` | OpenCut project root |
| `OPENAI_API_KEY` | — | Required by `generate_voice` with `provider: "openai"` |
| `ELEVENLABS_API_KEY` | — | Required by `generate_voice` with `provider: "elevenlabs"` |

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
│   ├── tools/                   # 59 tools across 11 tool modules
│   │   ├── index.ts              # Tool registry
│   │   ├── project.ts           # list/create/open/close/save/duplicate/delete
│   │   ├── timeline.ts          # tracks, clips, splits, trims, speed, volume, visibility
│   │   ├── text.ts              # text overlays, styling, positioning
│   │   ├── effects.ts           # transitions, filters, effects, stickers, animations, effect catalog
│   │   ├── audio.ts             # audio clips, fade in/out, denoise
│   │   ├── export.ts            # export profiles, render queue, status polling
│   │   ├── generation.ts        # create_video, render_project (Remotion / HyperFrames / motion)
│   │   ├── shots.ts             # motion shot library
│   │   ├── voice.ts             # generate_voice (OpenAI / ElevenLabs TTS)
│   │   ├── exchange.ts          # export_timeline_xml (Premiere / Filmora)
│   │   └── inspect.ts           # read-only project state queries
│   ├── data/
│   │   ├── effects.ts           # 20-effect catalog with face-safety + timing hints
│   │   └── shots.ts             # motion shot cards
│   ├── export/
│   │   └── xmeml.ts             # FCP7 XML (xmeml v4) builder for Premiere + Filmora
│   ├── render/
│   │   └── backends.ts          # Remotion / HyperFrames / motion render spawning
│   ├── tts/
│   │   └── backends.ts          # OpenAI + ElevenLabs speech synthesis
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
│   ├── install-unix.sh          # macOS/Linux fallback
│   └── smoke.mjs                # 37-check end-to-end smoke test
└── docs/
    ├── GETTING-STARTED.md
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
npm run smoke        # build + 37-check end-to-end smoke test (throwaway sandbox)
npm run verify       # typecheck, then smoke
```

Smoke-test the server locally:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}' \
  | node dist/index.js
```

You should see a JSON-RPC response with `serverInfo: { name: "mcp-video-editor", version: "1.1.0" }`.

## Limitations & notes

- **CapCut has no official API.** This server reads/writes CapCut's `draft_content.json` directly. CapCut must be **closed** (or at least not actively editing the same draft) when you call `save_project` with `dryRun: false`, otherwise the file may be locked — the server retries 3× on `EBUSY` but may still fail.
- **CapCut version drift.** CapCut changes its draft schema across versions. The adapter preserves unknown fields via `raw` at both the document root and per track/clip/material/text/effect node, so round-tripping older drafts is generally safe — but a field CapCut adds that lands outside a node we recognize still has no home, and a version that renames existing fields outright will read as missing data.
- **OpenCut schema.** OpenCut's project format is still evolving. The adapter tolerates both flat `tracks` and nested `timeline.tracks` shapes; the writer always emits the flat form (OpenCut ≥ 0.5).
- **Export is not actually rendering.** `export_project` records a queued request and emits a queued `renderProgress` notification, but no renderer is connected and no video file is created. `render_project` is the backend-driven render path that spawns a real renderer (`npx remotion render` or `npx hyperframes render`; the `motion` engine renders through Remotion's frame-stepping plus ffmpeg). A future backend must integrate with CapCut or OpenCut before export tasks can advance beyond queued.
- **CapCut and OpenCut are the only editors this server reads and writes. Premiere and Filmora are NOT supported yet — the export is beta.** `export_timeline_xml` produces FCP7 XML, the format both editors document, but a real import has never been tested because we do not have Premiere or Filmora installed. Output is XML-valid and unit-tested; whether Premiere/Filmora swallow it is unconfirmed. Do not rely on it for paid work until that is verified.
- **Native Premiere/Filmora support does not exist.** Premiere has no editable project file (it needs a running app plus a UXP/CEP plugin bridge) and Filmora's `.wfp` is undocumented. Both are separate architecture, not an adapter tweak.
- **xmeml drops things.** Text overlays, stickers, generic effects, transitions and speed ramps do not survive the exchange format; `export_timeline_xml` lists exactly what it skipped in its warnings. Audio is exported at 48 kHz with clip volume mapped to an Audio Levels filter.
- **`generate_voice` needs credentials and network.** It calls OpenAI or ElevenLabs directly; with `dryRun: true` (the default) nothing is synthesized.
- **`apply_face_effect` writes timeline data, not pixels.** It appends an `effect:<id>` entry (window + catalog metadata incl. `faceSafe`) to the project, so the editor or renderer still has to draw the effect. No face-tracking model runs in this server.
- **No UI automation.** If you need to drive CapCut's GUI (open menus, click filters), pair this server with a UI-automation layer (AutoHotkey on Windows).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each release (current: 1.1.0 — 59 tools, effects catalog, voice synthesis, motion engine, beta Premiere/Filmora export).

## License

MIT
