# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [1.1.0] — 2026-10-29

Tool count went from 54 to **59**. No editor adapters were rewritten — CapCut
and OpenCut remain the only editors this server reads and writes.

### Added

- **Effects catalog** — `list_effects`, `get_effect` over 20 curated effects
  (face-tracked, kinetic-text, color-grade, motion, sticker, ambient,
  checklist), each tagged `faceSafe` plus a `timingHint`.
- **`apply_face_effect`** — applies a catalog effect over a timeline window,
  validates the id against the catalog (with a "did you mean" suggestion),
  rejects `end <= start`, and warns in its summary when the effect is not
  face-safe. It writes timeline data (`effect:<id>`), not pixels — no
  face-tracking model runs here.
- **`generate_voice`** — MP3 voiceover through OpenAI (`tts-1`, `tts-1-hd`) or
  ElevenLabs (`eleven_multilingual_v2`), written under the export root.
  Requires `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`.
- **`motion` render engine** — third engine alongside Remotion and
  HyperFrames; scaffolds a composition folder and renders through Remotion
  frame-stepping plus ffmpeg.
- **Shot library** — `list_shots`, `get_shot` motion shot cards by category.
- **`export_timeline_xml` (BETA)** — FCP7 XML (xmeml v4) export aimed at Adobe
  Premiere and Wondershare Filmora. See the beta warning below.
- **Client configs** for Qwen Code (`configs/qwen-config.json`) and ZCode CLI
  (`configs/zcode-config.json`), plus setup sections in `docs/CLIENT_SETUP.md`.

### Changed

- Installers now treat Qwen Code and ZCode as **manual-merge** targets: both
  keep unrelated settings in the same file (`~/.qwen/settings.json`,
  `~/.zcode/cli/setting.json`), so the installers print the merge target
  instead of overwriting.
- Docs state 59 tools across 13 modules.

### Fixed

- `scripts/install-unix.sh` wrote Windows `C:\Users\...` paths from the config
  templates into macOS/Linux client configs. It now rewrites the project root,
  the home prefix and backslashes before writing.
- `applyFaceEffectSchema` in `src/tools/effects.ts` was dead code — defined but
  never registered. It now drives the real `apply_face_effect` tool.
- xmeml builder emitted `file-1` references without ever emitting the matching
  `<file>` definitions, and left `&` unencoded in `pathurl`. Both fixed; the
  sequence now uses FCP7's native `<project><children>` wrapper.

### Known limitations

- **Premiere and Filmora are not supported editors.** `export_timeline_xml` is
  beta and has never been imported into a real Premiere or Filmora install —
  neither app is available to this project. The XML is unit-tested and parses,
  nothing more. Do not use it for paid work until someone verifies it in-app.
- Native Premiere support would need a UXP/CEP plugin bridge into a running
  app; Filmora's `.wfp` is undocumented. Both are separate architecture.
- xmeml export drops text overlays, stickers, effects, transitions and speed
  ramps; the tool reports each skip in `warnings`.
- `export_project` still only records a queued render request — `render_project`
  is the path that actually spawns a renderer.
- Windows installer script is untested on Windows in this environment.

## [1.0.0]

Initial release: CapCut + OpenCut adapters, 54 tools, dry-run-by-default writes,
pre-write backups, schema validation, atomic writes, path-traversal guards,
stdio transport for Cursor, Claude Desktop, Codex CLI, Antigravity, OpenCode
and KiloCode.
