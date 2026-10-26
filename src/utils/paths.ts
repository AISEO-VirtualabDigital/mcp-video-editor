/**
 * Resolve CapCut and OpenCut file locations on Windows.
 *
 * CapCut stores drafts at:
 *   %LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<draft_id>\
 * Each draft folder contains `draft_content.json`, `draft_meta_info.json`,
 * and the source videos under a ` materials/` subfolder (loose convention).
 *
 * OpenCut (https://github.com/OpenCut-Editor/opencut) stores projects in:
 *   %USERPROFILE%\Documents\OpenCut\projects\<project-id>.json
 * (configurable via OPENCUT_PROJECTS_DIR env var).
 *
 * All paths returned here are absolute and forward-slash normalized so the
 * server can run unchanged on Windows, macOS, and Linux. The MCP server
 * itself targets Windows (per user choice) but the code remains portable.
 */

import path from "node:path";
import os from "node:os";
import { assertSafeProjectId } from "../safety/path-guard.js";

/** Normalize a Windows path to forward slashes for consistent handling. */
export function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** Join path segments with forward slashes. */
export function joinPath(...segments: string[]): string {
  return normalize(path.join(...segments));
}

/** Resolve CapCut drafts root. */
export function capcutDraftsRoot(): string {
  const localAppData =
    process.env.LOCALAPPDATA ||
    joinPath(os.homedir(), "AppData", "Local");
  return normalize(joinPath(localAppData, "CapCut", "User Data", "Projects", "com.lveditor.draft"));
}

/** Resolve one draft folder by draft id. Validates the id against path traversal. */
export function capcutDraftFolder(draftId: string): string {
  assertSafeProjectId(draftId, "draftId");
  return joinPath(capcutDraftsRoot(), draftId);
}

/** Resolve one draft_content.json path. Validates the id against path traversal. */
export function capcutDraftContentPath(draftId: string): string {
  return joinPath(capcutDraftFolder(draftId), "draft_content.json");
}

/** Resolve one draft_meta_info.json path. Validates the id against path traversal. */
export function capcutDraftMetaPath(draftId: string): string {
  return joinPath(capcutDraftFolder(draftId), "draft_meta_info.json");
}

/** Resolve OpenCut projects root (env-overridable). */
export function opencutProjectsRoot(): string {
  if (process.env.OPENCUT_PROJECTS_DIR) {
    return normalize(process.env.OPENCUT_PROJECTS_DIR);
  }
  return normalize(joinPath(os.homedir(), "Documents", "OpenCut", "projects"));
}

/** Resolve one OpenCut project path. Validates the id against path traversal. */
export function opencutProjectPath(projectId: string): string {
  assertSafeProjectId(projectId, "projectId");
  return joinPath(opencutProjectsRoot(), `${projectId}.json`);
}

/** Resolve the backups root used by the safety layer. */
export function backupsRoot(): string {
  if (process.env.MCP_VIDEO_BACKUP_DIR) {
    return normalize(process.env.MCP_VIDEO_BACKUP_DIR);
  }
  return normalize(joinPath(os.homedir(), ".mcp-video-editor", "backups"));
}

/** Resolve the cache root (used for dry-run output snapshots). */
export function cacheRoot(): string {
  if (process.env.MCP_VIDEO_CACHE_DIR) {
    return normalize(process.env.MCP_VIDEO_CACHE_DIR);
  }
  return normalize(joinPath(os.homedir(), ".mcp-video-editor", "cache"));
}

/** Resolve the export output root. */
export function exportRoot(): string {
  if (process.env.MCP_VIDEO_EXPORT_DIR) {
    return normalize(process.env.MCP_VIDEO_EXPORT_DIR);
  }
  return normalize(joinPath(os.homedir(), "Videos", "mcp-video-editor"));
}
