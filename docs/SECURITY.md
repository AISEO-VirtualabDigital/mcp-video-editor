# Security Audit Report

**Date:** 2026-10-26
**Scope:** `mcp-video-editor` TypeScript MCP server
**Auditor:** Z.ai (automated code review + manual verification)
**Status:** ✅ All findings remediated, all regression tests pass

## Threat model

The MCP server runs as the local user with full filesystem permissions. The AI client (Cursor, Claude Desktop, Codex, Antigravity, OpenCode, KiloCode, Qwen Code, ZCode CLI) is trusted to call tools with reasonable inputs, but a **prompt-injected or hostile AI** can call any tool with any arguments. Therefore:

1. Every user-supplied identifier that ends up in a path must be validated before use.
2. Every resolved path must be checked for containment inside the expected root before any filesystem mutation.
3. Defense in depth: check at the boundary (Zod schema) AND at the filesystem call site.

## Findings

### 🔴 CRITICAL — Path traversal via project/draft IDs (CWE-22)

**Files:** `src/utils/paths.ts` — `capcutDraftFolder()`, `capcutDraftContentPath()`, `capcutDraftMetaPath()`, `opencutProjectPath()`

**Issue:** These functions took a user-supplied `draftId` / `projectId` and joined it with a base directory using `path.join()`. `path.join()` collapses `..` segments, so a malicious AI client could pass `"../../etc/passwd"` or `"..\\..\\..\\Windows\\System32"` to escape the drafts root.

**Impact:** Combined with the `delete_project` tool's `fs.rm(..., { recursive: true, force: true })`, this would have allowed arbitrary folder deletion. With `save_project`, arbitrary file overwrite. With `open_project`, arbitrary file read.

**Reproduction (pre-fix):**
```
open_project(id="../../../../etc/passwd", editor="opencut")
→ reads /etc/passwd as a "project"
```

**Fix:** Added `assertSafeProjectId()` in `src/safety/path-guard.ts`. The ID must match `/^[A-Za-z0-9_.-]+$/`, can't start with a dot, can't be `.` or `..`, can't contain null bytes, can't exceed 256 chars. The path-resolving functions in `paths.ts` now call this guard before joining.

**Verified:** Security test #1, #11, #12, #13 confirm refusal of `../../etc/passwd`, `.env`, `foo/bar`, `foo\..\bar`.

---

### 🔴 CRITICAL — `delete_project` recursive delete without path containment (CWE-22 + CWE-73)

**File:** `src/tools/project.ts` lines 316-322 (pre-fix)

**Issue:** `delete_project` called `fs.rm(srcFolder, { recursive: true, force: true })` on a path derived entirely from user input. Even if the ID-based path traversal above were somehow bypassed (e.g. by an env var override of `OPENCUT_PROJECTS_DIR`), the recursive delete would proceed against any path.

**Fix:** Added explicit `assertPathInside(targetPath, rootPath, "delete target")` check both BEFORE `safeStat` and AFTER it (closing the TOCTOU window). Also refuses to operate on symlinks — `safeStat` now uses `fs.lstat` so `stat.isSymbolicLink()` is detectable.

**Verified:** Security test #2 confirms `delete_project(id="../../../", confirm=true, dryRun=false)` is refused — catastrophic if not.

---

### 🟠 HIGH — External source path accepted by `add_video_clip` / `add_audio_clip` (CWE-73)

**Files:** `src/tools/timeline.ts` (`addVideoClipSchema`), `src/tools/audio.ts` (`addAudioClipSchema`)

**Issue:** `sourcePath` was user-supplied and only validated by `safeStat()` (file existence check). An AI client could pass:
- `"C:\Windows\System32\config\SAM"` — sensitive system file
- `"\\attacker\share\payload.exe"` — Windows auto-authenticates to remote SMB servers (NTLM relay risk)
- `"//attacker/share/audio.wav"` — same, alternate UNC syntax
- `"\\\\.\\C:\\..."` — Windows device path

While no direct code execution happens (we just store the path string), CapCut will attempt to load that file when the draft is opened, causing:
- Information disclosure via error messages
- SMB relay attacks against the local user's NTLM hash
- Loading of attacker-controlled content from network shares

**Fix:** Added `assertSafeExternalPath()` in `src/safety/path-guard.ts`. Rejects:
- Non-absolute paths (no `~/...`, no relative)
- UNC paths (`\\server\share` or `//server/share`)
- Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`)
- Windows device paths (`\\.\C:\...`)
- Null bytes
- Paths longer than 4096 chars

The check runs even in dry-run mode so the AI gets feedback on unsafe paths before committing to a save.

**Verified:** Security tests #3, #4, #5, #6, #10 confirm refusal of UNC, relative, null-byte, and Windows device paths.

---

### 🟠 HIGH — `export_project` outputPath not validated (CWE-73)

**File:** `src/tools/export.ts` line 153

**Issue:** `outputPath` was user-supplied and used directly in `path.join(exportRoot(), ...)`. An AI client could write a render task JSON to any path on the filesystem, bypassing project root confinement.

**Fix:** When `outputPath` is supplied explicitly, we now run both `assertSafeExternalPath()` (UNC/device/null byte rejection) AND `assertPathInside(outputPath, exportRoot(), "outputPath")` to confine writes to the configured export root.

**Verified:** Security test #9 confirms `export_project(outputPath="/etc/passwd.mp4")` is refused.

---

### 🟡 MEDIUM — No size limit on JSON reads (CWE-400)

**File:** `src/utils/fs.ts` — `readJson()`

**Issue:** `fs.readFile(filePath, "utf-8")` had no size limit. A malicious or corrupted draft file could be gigabytes in size, causing OOM.

**Fix:** `readJson()` now `lstat`s the file first, refuses if it's a symlink, refuses if `stat.size > MAX_JSON_BYTES` (50 MiB), then reads.

**Verified by code inspection.**

---

### 🟡 MEDIUM — Symlink following (CWE-59)

**File:** `src/utils/fs.ts` — `safeStat`, `walkDir`

**Issue:** `fs.stat()` follows symlinks. A planted symlink inside the CapCut drafts folder pointing at `/etc/passwd` or `C:\Windows\System32\config\SAM` would have been:
- Read as if it were a real draft (`safeStat` reported it existed)
- Recursively walked (`walkDir` followed symlinked directories)
- Copied by `duplicate_project`'s `fs.copyFile`

**Fix:**
- `safeStat` now uses `fs.lstat` — callers can detect symlinks via `stat.isSymbolicLink()` and refuse.
- `walkDir` skips symlinked entries entirely (never follows, never reports).
- `readJson` refuses symlinks outright.
- `delete_project` and `duplicate_project` explicitly refuse symlinks at the source path.
- The CapCut `duplicate_project` folder copy now skips symlinked entries inside the draft folder.

**Verified by code inspection.**

---

### 🟡 MEDIUM — TOCTOU race in `delete_project` (CWE-367)

**File:** `src/tools/project.ts`

**Issue:** `safeStat(targetPath)` was called first, then later `fs.rm(targetPath, ...)`. Between these two operations, the path could be replaced with a symlink to a sensitive file/folder. The `fs.rm` would then recursively delete the symlink target.

**Fix:** Added a second `assertPathInside` check after `safeStat` (closing the window as much as possible without atomic operations). Also added the symlink refusal — `fs.lstat` returns `isSymbolicLink()` and we refuse to operate on it.

**Caveat:** A true TOCTOU fix would require `openat()` with `O_NOFOLLOW` and operate on the file descriptor. This is a defense-in-depth mitigation, not a complete fix. The threat model assumes the drafts folder is not world-writable (it's under `%LOCALAPPDATA%` on Windows, which is per-user).

---

### 🟡 MEDIUM — Cache directory unbounded growth (CWE-400)

**File:** `src/safety/dry-run.ts`

**Issue:** Every dry-run invocation wrote a `<nanoid>.preview.json` to the cache directory, never cleaning up. Each preview is the full project state. Long-running sessions could fill the disk.

**Current state:** preview snapshots are now opt-in (`MCP_VIDEO_DRY_RUN_SNAPSHOT=1`) and route through `writeSerialized`. When enabled, the janitor below still bounds the directory at 100 MiB; when disabled — the default — nothing is written at all.

**Fix:** Added `janitCache()` which runs after every dry-run write. Walks `<cacheRoot>/dry-run/`, sorts entries by mtime ascending, deletes oldest until total size is under 90% of `MAX_CACHE_BYTES` (100 MiB default). Hysteresis prevents thrashing.

**Verified by code inspection.**

---

### 🟢 LOW — Tool result payload unbounded (CWE-400)

**File:** `src/server.ts` line 134

**Issue:** `JSON.stringify(result.data ?? {}, null, 2)` had no size cap. A `get_timeline` call on a large project could return megabytes of JSON, DoSing the AI client's context window (most clients have ~200k token limits).

**Fix:** Added `truncateForToolResult()` in `src/safety/dry-run.ts`. If the payload exceeds `MAX_TOOL_RESULT_BYTES` (1 MiB), it's truncated at a UTF-8 character boundary with a marker explaining how to fetch a subset (use `get_clips` with `trackId`).

**Verified by code inspection.**

---

### 🟢 LOW — Information disclosure in error messages

**Files:** Throughout

**Issue:** Error messages include full file paths (e.g. `CapCut draft not found: /home/user/.../draft_content.json`). For a single-user local server this is intended (the AI needs to know where files are), but if the server were ever exposed via a remote MCP transport, this would leak filesystem layout.

**Decision:** Accepted risk for the local stdio use case. Document in README that the server is **not** designed to be exposed over a network transport without an additional authz layer.

---

### 🟢 LOW — Environment variables trusted without validation

**Files:** `src/utils/paths.ts` — `OPENCUT_PROJECTS_DIR`, `MCP_VIDEO_BACKUP_DIR`, `MCP_VIDEO_CACHE_DIR`, `MCP_VIDEO_EXPORT_DIR`

**Issue:** These env vars override default locations. If an attacker could set env vars (e.g. via a malicious shell profile), they could redirect all file operations.

**Decision:** Accepted risk. The threat model assumes the user controls env vars (they're set by the user, not by AI tool calls). The installer scripts set them explicitly.

---

### 🟢 LOW — Notification bus swallows listener errors

**File:** `src/notifications/events.ts`

**Issue:** All bus listeners are wrapped in `try/catch` that ignores errors. If a real bug occurred in a listener, it would be silently swallowed.

**Decision:** Accepted risk. The bus is fire-and-forget by design — a notification failure must never crash a tool call. The MCP server's `notify()` function logs warnings via `bus.log("warning", ...)` which the AI client can see.

---

## Tests added

### `scripts/security-test.mjs`

13-test regression suite covering every fix above. Run with:

```bash
node scripts/security-test.mjs
```

All 13 tests pass:

| # | Test | Expected | Status |
|---|------|----------|--------|
| 1 | `open_project(id="../../etc/passwd")` | Refused | ✅ |
| 2 | `delete_project(id="../../../", confirm=true, dryRun=false)` | Refused (catastrophic if not) | ✅ |
| 3 | `add_video_clip(sourcePath="\\\\attacker\\share\\p.exe")` | Refused (UNC) | ✅ |
| 4 | `add_video_clip(sourcePath="./video.mp4")` | Refused (relative) | ✅ |
| 5 | `add_video_clip(sourcePath="/tmp/file\x00.exe")` | Refused (null byte) | ✅ |
| 6 | `add_audio_clip(sourcePath="//attacker/share/audio.wav")` | Refused (UNC) | ✅ |
| 7 | `open_project(id=legit)` | OK (regression) | ✅ |
| 8 | `delete_project(id=legit, dryRun=true)` | OK (regression) | ✅ |
| 9 | `export_project(outputPath="/etc/passwd.mp4")` | Refused (path escape) | ✅ |
| 10 | `add_video_clip(sourcePath="\\\\.\\C:\\Windows\\...")` | Refused (device path) | ✅ |
| 11 | `open_project(id=".env")` | Refused (leading dot) | ✅ |
| 12 | `open_project(id="foo/bar")` | Refused (slash) | ✅ |
| 13 | `open_project(id="foo\\..\\bar")` | Refused (backslash) | ✅ |

## Files changed

| File | Change |
|------|--------|
| `src/safety/path-guard.ts` | **NEW** — `assertSafeProjectId`, `assertPathInside`, `assertSafeExternalPath`, `assertNotSymlink`, `assertNoSymlinkInPath`, `MAX_JSON_BYTES`, `MAX_CACHE_BYTES`, `MAX_TOOL_RESULT_BYTES` constants |
| `src/utils/paths.ts` | `capcutDraftFolder`, `capcutDraftContentPath`, `capcutDraftMetaPath`, `opencutProjectPath` now call `assertSafeProjectId` before `path.join` |
| `src/utils/fs.ts` | `readJson` enforces `MAX_JSON_BYTES` + refuses symlinks; `safeStat` uses `lstat`; `walkDir` skips symlinks; added `resolveRealPath`; `copyFile` uses `COPYFILE_FICLONE` (not `_FORCE` — fails on tmpfs) |
| `src/tools/project.ts` | `delete_project` adds `assertPathInside` (twice — pre and post stat for TOCTOU), refuses symlinks; `duplicate_project` adds `assertPathInside` on source + dest, refuses symlinks, skips symlinked entries in CapCut folder copy |
| `src/tools/timeline.ts` | `add_video_clip` calls `assertSafeExternalPath` + refuses symlinked source files |
| `src/tools/audio.ts` | `add_audio_clip` calls `assertSafeExternalPath` + refuses symlinked source files |
| `src/tools/export.ts` | `export_project` validates `outputPath` with `assertSafeExternalPath` + `assertPathInside(exportRoot)` when explicitly supplied |
| `src/safety/dry-run.ts` | Added `janitCache()` (LRU cleanup of preview cache > 100 MiB) + `truncateForToolResult()` (1 MiB payload cap) |
| `src/server.ts` | Tool result payload truncated to 1 MiB; truncation marker added |

## Residual risks

1. **TOCTOU on delete.** Mitigated but not eliminated — would need `openat(O_NOFOLLOW)` for full fix. Accepted risk given per-user drafts folder.
2. **Prompt injection.** If a malicious CapCut draft file is loaded (e.g. someone sends the user a `draft_content.json` with crafted `texts` containing prompt-injection text), the AI client will read those texts via `get_texts` and may follow the injected instructions. **Mitigation:** the AI client (Cursor/Claude/etc.) is responsible for sanitizing tool output before feeding it back to the model. Users should only open drafts from trusted sources.
3. **Local privilege escalation.** The server runs as the local user. Any compromise via the MCP protocol is a compromise of the user's full filesystem. The dry-run default + backups + confirm gate on destructive ops limit the blast radius but cannot eliminate it.
4. **No authentication on stdio.** Any process that can spawn this server (or write to its stdin) can call any tool. The threat model assumes the AI client is the only process spawning the server. If you expose the server over a network transport (SSE/HTTP), you MUST add an auth layer.

## Recommendations for future work

1. **Optional root confinement for source paths.** Currently `assertSafeExternalPath` allows any absolute non-UNC path. Add an env-var `MCP_VIDEO_ALLOWED_SOURCE_ROOTS` (comma-separated) that, when set, restricts source paths to be inside one of those roots. Useful for high-security deployments.
2. **Audit logging.** Add a structured audit log of every write operation (tool name, args, target path, success/failure) to a separate file under `~/.mcp-video-editor/audit.log`. Currently the notification bus emits `notifications/projectChanged` events but they're only delivered to the connected AI client, not persisted.
3. **Sandboxed subprocess for CapCut CLI.** If CapCut ever exposes a CLI for headless render, run it under `bubblewrap`/`AppContainer` to limit filesystem access.
4. **Per-project capability tokens.** Generate a random token per project and require it on every write operation targeting that project. Prevents a hostile AI from writing to projects it didn't open (defense in depth against cache poisoning).

## Test coverage

- **Functional tests:** 14 e2e scenarios pass (`scripts/e2e-test.mjs`)
- **Security tests:** 13 scenarios pass (`scripts/security-test.mjs`)
- **Smoke tests:** 50-tool registration + list_projects call (`scripts/smoke-test.mjs`)
- **TypeScript:** `tsc --noEmit` clean (21 source files, ~4,300 LOC after patches)
