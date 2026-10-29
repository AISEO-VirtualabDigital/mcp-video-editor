# Architecture

## Overview

```
                ┌─────────────────────────────────────────────────┐
                │           AI Client (Cursor, Claude, ...)         │
                └─────────────────────┬───────────────────────────┘
                                      │ JSON-RPC 2.0 over stdio
                                      ▼
                ┌─────────────────────────────────────────────────┐
                │                  McpServer                       │
                │  (SDK: @modelcontextprotocol/sdk/server/mcp.js)  │
                └─────────────────────┬───────────────────────────┘
                                      │ tools/call
                                      ▼
                ┌─────────────────────────────────────────────────┐
                │              Tool Registry                       │
                │  13 modules, 59 tools total                     │
                │  Each tool: name + description + Zod input      │
                │  schema + async run() -> ToolResult              │
                └─────────────────────┬───────────────────────────┘
                                      │
                                      ▼
                ┌─────────────────────────────────────────────────┐
                │              Editor Facade                       │
                │  openProject / saveProject / createProject       │
                │  listProjects (kind: capcut | opencut)            │
                └─────────┬─────────────────────────┬─────────────┘
                          │                         │
                          ▼                         ▼
              ┌───────────────────┐     ┌───────────────────┐
              │  CapCut adapter   │     │  OpenCut adapter  │
              │  draft_content    │     │  project.json     │
              │  JSON read/write  │     │  JSON read/write  │
              └─────────┬─────────┘     └─────────┬─────────┘
                        │                         │
                        ▼                         ▼
              ┌───────────────────┐     ┌───────────────────┐
              │ %LOCALAPPDATA%\   │     │ %USERPROFILE%\     │
              │ CapCut\User Data\ │     │ Documents\OpenCut\ │
              │ Projects\...       │     │ projects\*.json    │
              └───────────────────┘     └───────────────────┘
```

## Data flow: write path

When a tool like `add_video_clip` is invoked:

1. **MCP server** receives `tools/call` with `name=add_video_clip` and `arguments={...}`.
2. **Tool registry** looks up the tool and calls `tool.run(args)`.
3. The tool calls `facade.getOpenProject(projectId)` to fetch the in-memory `EditorProject`.
4. The tool mutates the project (adds the clip).
5. The tool calls `facade.cacheProject(project)` to push the mutated copy back into the cache so subsequent reads see it.
6. The tool returns a `ToolResult` with `dryRun=true` (default). The editor project is not written, though some dry-run operations save a preview snapshot in the MCP cache directory.
7. If the AI later calls `save_project` with `dryRun=false`:
   - `executeWrite()` runs `backupFile()` first, copying the existing file to `~/.mcp-video-editor/backups/...`.
   - `apply()` calls `facade.saveProject(project)`, which dispatches to the editor-specific adapter.
   - The adapter re-emits the vendor JSON shape (CapCut `draft_content.json` or OpenCut project JSON) and writes it atomically (temp file + rename).
   - `bus.emitProjectChanged(...)` fires, which the MCP server forwards as a `notifications/projectChanged` MCP notification to the client.

## Data flow: read path

Read tools (`get_project_state`, `get_timeline`, etc.) operate purely against the in-memory cache. The cache is populated by `open_project`, which:

1. Resolves the file path (`capcutDraftContentPath(id)` or `opencutProjectPath(id)`).
2. Reads + parses the JSON file.
3. Asserts the vendor schema shape (`assertCapcutDraft` / `assertOpencutProject`).
4. Normalizes to `EditorProject`:
   - CapCut: walks `materials.videos/audios/images/texts/stickers`, builds flat `materials[]`. Walks `tracks[].segments[]`, builds `clips[]` with source/target time ranges. Pulls text overlays from `materials.texts[]` and finds their timeline window via the text track's segments.
   - OpenCut: similar but flat `tracks`/`clips` arrays; simpler normalization.
5. Validates the normalized project (`assertValidProject` — no overlapping clips on the same track, no dangling material refs, etc.).
6. Caches by project id.

## Schema normalization

The internal `EditorProject` shape is editor-agnostic:

```ts
interface EditorProject {
  id: string;
  name: string;
  editor: "capcut" | "opencut";
  filePath: string;
  duration: number;     // microseconds
  width: number;
  height: number;
  fps: number;
  tracks: Track[];       // flat array of tracks
  materials: Material[]; // flat array of materials
  texts: TextOverlay[];  // flat array of text overlays
  effects: EffectRef[];  // flat array of effects
  raw?: Record<string, unknown>;  // vendor round-trip bag
}
```

Both adapters convert to this shape on read and from it on write. Unknown vendor fields are preserved in `raw` so a write never loses data the adapter doesn't understand.

## Notification bus

The `NotificationBus` is a tiny typed emitter. Tools fire events via `bus.emitProjectChanged(...)` and `bus.emitRenderProgress(...)`. The MCP server subscribes these to MCP server-sent notifications via the underlying `Server.notification()` method.

Three notification channels:

| Method | Payload | When |
| --- | --- | --- |
| `notifications/projectChanged` | `{ projectId, kind, change, filePath, at }` | Every draft write, open, close, save |
| `notifications/renderProgress` | `{ projectId, phase, progress, outputPath?, error?, at }` | Render request recorded as queued; no renderer is currently connected |
| `notifications/message` | `{ level, data, logger, timestamp }` | Logs (info / warning / error) |

All 6 supported AI clients handle `notifications/message` out of the box. Custom channels (`notifications/projectChanged`, `notifications/renderProgress`) are exposed for clients that subscribe to specific notification types.

## Safety guarantees

1. **Dry-run default.** Every write tool's `dryRun` schema field defaults to `true`. The mutation runs against the in-memory cache (so the AI can immediately query the new state) but no disk IO happens.
2. **Backups before real writes/deletes.** `executeWrite()` copies an existing target file before overwrite. `delete_project` copies the whole project file/folder before removal. Backups are never auto-deleted.
3. **Schema validation.** `assertCapcutDraft`, `assertOpencutProject`, and `assertValidProject` validate both vendor shapes and the normalized project. Writes are refused on validation failure.
4. **Atomic writes.** All JSON writes go through `writeJson()` which writes to a temp file (with a nanoid suffix) and then `fs.rename()`s it into place — atomic on the same filesystem, so a crashed write never leaves a half-written draft.
5. **Destructive ops require explicit confirmation.** `delete_project` requires `confirm: true`.
6. **Retry on EBUSY.** CapCut briefly locks draft files during render. `withRetry()` retries 3× with exponential backoff on `EBUSY` / `EPERM` / `ENOENT`.

## Editor invariants enforced

- Clip `targetEnd >= targetStart`.
- Clip `sourceOut >= sourceIn`.
- No two clips on the same track overlap (sorted by `targetStart`, then sequential).
- Every `clip.materialId` must resolve to a known `material.id` in the project.
- Project `duration` equals `max(clip.targetEnd)` across all tracks (recomputed after every mutation).
- Project `width > 0`, `height > 0`, `fps > 0`.
- No duplicate `track.id`, `clip.id`, or `material.id`.
