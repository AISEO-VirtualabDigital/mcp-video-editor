# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [1.2.0] — 2026-10-29

No new tools — the count stays at **59**, and CapCut/OpenCut remain the only
editors. This release is the write-path, typing, and onboarding pass.

### Performance

- **CapCut writes no longer do per-clip material lookups.** `buildCapcutDraft`
  builds one `Map<materialId, type>` up front, so resolving `material_type` for
  every segment is O(clips + materials) instead of O(clips × materials). The
  old helper `inferMaterialType` ran a linear `find` per clip inside a `map`
  over the whole timeline; it is gone.
- **Serialization happens once per save.** Every mutation site now calls
  `facade.serializeProject(project)` and hands the finished string to
  `saveProjectSerialized` inside `withRetry`. Previously an `EBUSY` retry loop
  re-ran `JSON.stringify` on the entire project up to three times, which on a
  large timeline meant ~3× the CPU of the actual write. Affects `timeline`,
  `effects`, `audio`, `generation`, `project`, and `text`.
- **Narrower file-lock window.** `writeJson` and `writeText` share one
  `writeSerialized` implementation: the temp file is opened with `wx`, written
  through a single handle, closed, and only then renamed. Only the `rename`
  touches the destination path, which is the smallest window Windows gives us
  against CapCut's folder lock.
- **Dry-run preview snapshots are opt-in.** A dry-run used to serialize the
  project a second time and write a full copy into the cache on *every* call.
  Set `MCP_VIDEO_DRY_RUN_SNAPSHOT=1` to restore that behaviour; the default
  returns `previewPath: null` because the in-memory cache already holds the
  proposed state.
- **What was not changed, deliberately:** there was no
  `JSON.parse(JSON.stringify(...))` anywhere in `src/` to replace. The single
  deep clone is `structuredClone` (`src/tools/timeline.ts`), which is already
  V8-native, and the timeline tools were already doing one `tracks.find` plus
  one `clips.find` — not nested scans.

### Added

- **`src/adapters/raw.ts`** — the sanctioned place where an unmodelled vendor
  object is widened into `RawBag` (`Record<string, unknown>`), plus `isRecord`,
  `toRawBag`, `ensureBag`, `copyBag`, and typed `readString` / `readNumber` /
  `readBoolean` / `readArray` readers.
- **`docs/GETTING-STARTED.md`** — end-to-end onboarding: prerequisites, Windows
  PowerShell and Unix install, what the installers do and refuse to do, manual
  registration for all 8 clients, the runtime contract (open-before-mutate,
  dry-run default, CapCut-closed requirement, backups, path confinement), env
  var table, and a troubleshooting table.
- **`scripts/smoke.mjs`**, wired to `npm run smoke` — boots the built server in
  a throwaway sandbox and asserts 25 behaviours: tool count and registration,
  create → open → track → clip → timeline, the dry-run no-write guarantee, XML
  export plus its BETA labelling, path-traversal and export-root refusal,
  vendor-field round-trip, and absence of temp-file litter. `npm run verify`
  runs the typecheck and then the smoke test.

### Changed

- **OpenCut round-trips now preserve unmodelled vendor fields.** CapCut already
  spread its cached raw root back over the document; OpenCut silently dropped
  any key it did not model. Root, track, clip, material, text, and effect bags
  are now spread in, so third-party metadata survives read → mutate → write.
- **Read/write split into pure builders.** `buildCapcutDraft` and
  `buildOpencutProject` produce the vendor document; `writeCapcutDraft` and
  `writeOpencutProject` are thin serialize-and-write wrappers over
  `facade.buildVendorDocument`. This is what makes serialize-once possible.

### Typing

- Type guards replaced casts in `src/safety/validator.ts` (root, material, and
  clip checks now narrow via `isRecord`) and in `src/server.ts` (a
  `LowLevelNotifier` interface for `notification()`, and a `hasShape` guard for
  Zod object schemas, replacing two `as unknown as` escapes).
- Effect and audio mutations write into `clip.raw` / `material.raw` bags
  directly instead of casting them at each assignment.
- Explicit `as Record<string, unknown>` / `as unknown as` occurrences dropped
  from 12 to 6. The two remaining `as unknown as` are intentional: widening a
  vendor root into its own type is exactly what `toRawBag` centralizes.

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
