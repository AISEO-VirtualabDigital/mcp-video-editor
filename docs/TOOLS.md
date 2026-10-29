# Tool Reference

All 58 tools exposed by the MCP server. Time units are microseconds (`1_000_000 = 1s`).

## Project management

| Tool | Args | Returns | Notes |
| --- | --- | --- | --- |
| `list_projects` | `editor: "capcut"\|"opencut"` | `{ projects: [{ id, name, duration, updatedAt, filePath }] }` | Read-only |
| `create_project` | `name`, `editor`, `width=1920`, `height=1080`, `fps=30`, `dryRun=true` | `{ id, editor, name }` | Refuses to write when dryRun=true |
| `open_project` | `id`, `editor` | Normalized `EditorProject` summary | Loads into cache; subsequent tools operate on the cached copy |
| `close_project` | `id` | `{ ok }` | Cache-only; on-disk file unchanged |
| `save_project` | `id`, `dryRun=true` | `{ backupPath?, targetPath }` | Backs up before write when dryRun=false |
| `duplicate_project` | `id`, `editor`, `newName`, `dryRun=true` | `{ sourceId, newId, destPath, editor }` | Copies the whole draft folder for CapCut |
| `delete_project` | `id`, `editor`, `confirm`, `dryRun=true` | `{ id, targetPath, editor, backupPath }` | Requires `confirm: true`; backs up the whole project before deletion |

## Timeline & clips

| Tool | Args | Notes |
| --- | --- | --- |
| `add_track` | `id`, `kind`, `volume?`, `visible?`, `dryRun=true` | kind ∈ video/audio/text/sticker/effect |
| `remove_track` | `id`, `trackId`, `dryRun=true` | All clips on the track are dropped |
| `add_clip` | `id`, `trackId`, `materialId`, `sourceIn=0`, `sourceOut`, `targetStart?`, `dryRun=true` | Appends to end of track if targetStart omitted |
| `add_video_clip` | `id`, `trackId`, `sourcePath`, `duration`, `width=1920`, `height=1080`, `sourceIn=0`, `sourceOut?`, `targetStart?`, `dryRun=true` | Convenience: also creates the material |
| `split_clip` | `id`, `trackId`, `clipId`, `at`, `dryRun=true` | `at` must be strictly between `targetStart` and `targetEnd` |
| `trim_clip` | `id`, `trackId`, `clipId`, `newSourceIn?`, `newSourceOut?`, `newTargetStart?`, `newTargetEnd?`, `dryRun=true` | Only supplied fields change |
| `move_clip` | `id`, `trackId`, `clipId`, `newTargetStart`, `dryRun=true` | Duration preserved; rejects overlap on the same track |
| `delete_clip` | `id`, `trackId`, `clipId`, `dryRun=true` | |
| `set_clip_speed` | `id`, `trackId`, `clipId`, `speed`, `dryRun=true` | Speed ∈ [0.1, 10]; target duration = sourceDur/speed |
| `set_track_volume` | `id`, `trackId`, `volume`, `dryRun=true` | Volume ∈ [0, 1] |
| `set_track_visibility` | `id`, `trackId`, `visible`, `dryRun=true` | |

## Text & captions

| Tool | Args |
| --- | --- |
| `add_text` | `id`, `text`, `start`, `end`, `fontFamily?`, `fontSize?`, `color?`, `backgroundColor?`, `bold?`, `italic?`, `x?`, `y?`, `dryRun=true` |
| `update_text` | `id`, `textId`, `text?`, `start?`, `end?`, `fontFamily?`, `fontSize?`, `color?`, `backgroundColor?`, `bold?`, `italic?`, `x?`, `y?`, `dryRun=true` |
| `delete_text` | `id`, `textId`, `dryRun=true` |
| `set_text_style` | `id`, `textId`, `fontFamily?`, `fontSize?`, `color?`, `backgroundColor?`, `bold?`, `italic?`, `dryRun=true` |
| `set_text_position` | `id`, `textId`, `x`, `y`, `dryRun=true` |

## Transitions / effects

| Tool | Args |
| --- | --- |
| `add_transition` | `id`, `trackId`, `clipId`, `type`, `duration=500_000`, `side="in"\|"out"`, `dryRun=true` |
| `remove_transition` | `id`, `trackId`, `clipId`, `side`, `dryRun=true` |
| `add_filter` | `id`, `type`, `start`, `end`, `intensity=1`, `dryRun=true` |
| `add_effect` | `id`, `type`, `start`, `end`, `params?`, `dryRun=true` |
| `remove_effect` | `id`, `effectId`, `dryRun=true` |
| `add_sticker` | `id`, `stickerId`, `start`, `end`, `x`, `y`, `scale=1`, `dryRun=true` |
| `add_animation` | `id`, `trackId`, `clipId`, `type`, `duration=500_000`, `side`, `dryRun=true` |
| `list_effects` | `category?` | `{ effects, categories, count }` | Read-only; lists the video effects catalog with face-safety info |
| `get_effect` | `effectId` | `{ effect }` | Read-only; returns a single effect (category, faceSafe, timingHint) |
| `apply_face_effect` | `id`, `effectId`, `start`, `end`, `params?`, `dryRun=true` | Cache update + `{ projectId, dryRun }` | Validates `effectId` against the catalog, rejects `end <= start`, appends `effect:<id>` with catalog metadata, warns when `faceSafe` is false |

## Audio

| Tool | Args |
| --- | --- |
| `add_audio_clip` | `id`, `trackId`, `sourcePath`, `duration`, `sourceIn=0`, `sourceOut?`, `targetStart?`, `volume?`, `dryRun=true` |
| `adjust_volume` | `id`, `trackId`, `clipId`, `volume`, `dryRun=true` |
| `adjust_track_volume` | `id`, `trackId`, `volume`, `dryRun=true` |
| `fade_in` | `id`, `trackId`, `clipId`, `duration`, `dryRun=true` |
| `fade_out` | `id`, `trackId`, `clipId`, `duration`, `dryRun=true` |
| `split_audio` | `id`, `trackId`, `clipId`, `at`, `dryRun=true` |
| `denoise` | `id`, `trackId`, `clipId`, `enable=true`, `dryRun=true` |

## Generation & rendering

| Tool | Args | Returns | Notes |
| --- | --- | --- | --- |
| `create_video` | `name`, `editor`, `engine`, `width=1920`, `height=1080`, `fps=30`, `durationInSeconds`, `clips?`, `texts?`, `audio?`, `dryRun=true` | `{ id, name, editor, engine, duration, width, height, fps, tracks, materials, texts, filePath }` | Creates a new video project from a programmatic generation spec (Remotion / HyperFrames / Motion engine). When `engine` is `hyperframes` or `motion`, a composition scaffold is written into the project folder. |
| `render_project` | `id`, `engine`, `entry?`, `compositionId?`, `outputPath?`, `dryRun=true` | `{ taskId, projectId, engine, outputPath, phase }` | Spawns the backend renderer (`npx remotion render` or `npx hyperframes render`; `motion` renders via frame-stepping + ffmpeg via Remotion), streams progress, writes output under the export root. |

## Shot library

| Tool | Args | Returns | Notes |
| --- | --- | --- | --- |
| `list_shots` | `category?` | `{ categories, shots, count }` | Read-only; lists motion shot categories + cards |
| `get_shot` | `shotId` | `{ shot: ShotCard }` | Read-only; returns a single shot card |

## Voice synthesis

| Tool | Args | Returns | Notes |
| --- | --- | --- | --- |
| `generate_voice` | `text`, `provider`, `voice?`, `model?`, `outputPath?`, `dryRun=true` | `{ provider, voice, model, outputPath, bytesWritten, dryRun }` | Synthesizes MP3 via OpenAI or ElevenLabs TTS; requires `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`. |

## Export & render

| Tool | Args | Returns |
| --- | --- | --- |
| `list_export_profiles` | `{}` | `{ profiles: { "1080p-30", "1080p-60", "4k-30", "4k-60", "720p-30" } }` |
| `set_export_params` | `id`, `profileName?`, `custom?`, `dryRun=true` | `{ profile, profilePath }`; backs up existing profile on write |
| `export_project` | `id`, `profileName?`, `outputPath?`, `dryRun=true` | `{ taskId, projectId, profile, outputPath, phase? }`; records a queued request only, no video is rendered |
| `get_render_status` | `taskId` | Full `RenderTask` |
| `list_render_tasks` | `id?` | `{ tasks: RenderTask[] }` |

> Note: `export_project` remains a queued-request stub. `render_project` is the backend-driven render entry point that actually spawns a renderer.

Export profiles:

| Name | Resolution | FPS | Bitrate | Codec |
| --- | --- | --- | --- | --- |
| `720p-30` | 1280×720 | 30 | 4 Mbps | h264 |
| `1080p-30` | 1920×1080 | 30 | 8 Mbps | h264 |
| `1080p-60` | 1920×1080 | 60 | 12 Mbps | h264 |
| `4k-30` | 3840×2160 | 30 | 35 Mbps | h265 |
| `4k-60` | 3840×2160 | 60 | 50 Mbps | h265 |

## Inspect / query

| Tool | Args | Returns |
| --- | --- | --- |
| `get_project_state` | `id` | `{ id, name, editor, filePath, duration, width, height, fps, trackCount, materialsCount, textsCount, effectsCount }` |
| `get_timeline` | `id`, `offset=0`, `limit=50` (max 200) | `{ duration, totalClips, offset, limit, hasMore, tracks: [...] }` |
| `get_clips` | `id`, `trackId?`, `offset=0`, `limit=50` (max 200) | `{ total, offset, limit, hasMore, clips: [...] }` |
| `get_track_info` | `id`, `trackId` | Full `Track` object |
| `get_materials` | `id` | `{ materials: [...] }` |
| `get_texts` | `id` | `{ texts: [...] }` |
| `get_effects` | `id` | `{ effects: [...] }` |
| `get_open_project_ids` | `{}` | `{ ids: string[] }` |

## Dry-run semantics

Every write tool has a `dryRun` parameter that defaults to `true`. Behavior:

- `dryRun=true` (default): project edits update the in-memory project cache so the AI can immediately call `get_*` to inspect the new state. They are not written to the editor project unless separately saved with `save_project` and `dryRun=false`. Some dry-run operations cache a preview snapshot under the configured MCP cache directory.
- `dryRun=false`: the project is mutated AND persisted to disk. A backup is created first (`~/.mcp-video-editor/backups/...`). A `notifications/projectChanged` notification is emitted.
- Video/audio source paths must refer to existing regular files in both dry-run and live calls. Dry-run checks the source but does not write the project.
- Invalid timeline edits are discarded without changing the open project cache. Clips may not overlap on the same track.
- Export requests are not renders: without a connected renderer, live requests remain queued and no video file is created. `render_project` is the backend-driven path that spawns a real renderer. Unknown preset names are rejected instead of silently falling back.

## Tool result shape

Every tool returns:

```ts
interface ToolResult {
  ok: boolean;
  summary: string;     // human-readable for the AI client
  data?: unknown;      // structured payload the AI can reason over
  backupPath?: string;  // path to the .bak file when a write happened
  dryRun?: boolean;    // true when dry-run was honored
  error?: string;      // present when ok=false
}
```

The MCP server wraps this as `{ content: [{ type: "text", text: <summary> }, { type: "text", text: <JSON of data> }], isError: !ok }`.
