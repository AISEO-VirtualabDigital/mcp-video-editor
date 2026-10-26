/**
 * Dry-run executor — wraps a write operation so that the MCP tool can return
 * a fully-shaped `ToolResult` describing what *would* happen, without
 * touching the user's draft.
 *
 * Behavior:
 *   - If `dryRun: true`  -> execute the "would" branch; no backup; no file write.
 *   - If `dryRun: false` -> back up the target file, then run `apply()` which
 *                          performs the real write.
 *
 * Either way, a structured `ToolResult` is returned to the MCP server.
 *
 * The default is **dryRun: true** — i.e. every write tool must opt OUT of
 * dry-run by passing `dryRun: false` explicitly. This is the read-only default
 * the user selected during clarification.
 *
 * Cache management: every dry-run writes a preview snapshot to
 * `<cacheRoot>/dry-run/<nanoid>.preview.json`. To prevent unbounded growth,
 * we run a janitor after each write that deletes oldest files when the total
 * cache size exceeds MAX_CACHE_BYTES (100 MiB).
 */

import { backupFile, type BackupResult } from "./backup.js";
import { writeJson } from "../utils/fs.js";
import { cacheRoot } from "../utils/paths.js";
import { ensureDir, listDir, safeStat } from "../utils/fs.js";
import { MAX_CACHE_BYTES, MAX_TOOL_RESULT_BYTES } from "./path-guard.js";
import path from "node:path";
import fs from "node:fs/promises";
import { nanoid } from "nanoid";
import type { ToolResult } from "../adapters/types.js";

export interface DryRunOptions {
  /** When true, no real file write happens. Default: true. */
  dryRun?: boolean;
  /** Target file path (for backups + dry-run cache snapshot). */
  targetPath: string;
  /** The new value that would be written. */
  newValue: unknown;
  /** Human-readable description of the operation. */
  description: string;
  /** Apply callback: only invoked when dryRun is false. */
  apply: () => Promise<void>;
}

/**
 * Execute a write operation honoring the dry-run setting. Always returns a
 * structured ToolResult.
 */
export async function executeWrite(opts: DryRunOptions): Promise<ToolResult> {
  const { dryRun = true, targetPath, newValue, description, apply } = opts;

  if (dryRun) {
    // Persist a "preview" snapshot to the cache so the AI/client can read the
    // proposed new state. This never touches the real draft path.
    const cachePath = path.join(cacheRoot(), "dry-run", `${nanoid(8)}.preview.json`);
    await ensureDir(path.dirname(cachePath));
    await writeJson(cachePath, newValue);
    // Best-effort cache janitor — fire-and-forget.
    void janitCache().catch(() => {
      /* swallow — janitor failures must not crash the tool call */
    });
    return {
      ok: true,
      summary: `[DRY-RUN] ${description}. No file written. Preview cached at ${cachePath}.`,
      data: { dryRun: true, previewPath: cachePath, targetPath },
      dryRun: true,
    };
  }

  // Real write — back up first.
  let backup: BackupResult | null = null;
  try {
    backup = await backupFile(targetPath);
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      summary: `Backup failed: ${e.message}. Write aborted.`,
      error: e.message,
    };
  }

  try {
    await apply();
    return {
      ok: true,
      summary: description + (backup ? ` (backup: ${backup.backupPath})` : " (no prior file to back up)"),
      data: {
        dryRun: false,
        targetPath,
        backupPath: backup?.backupPath ?? null,
      },
      backupPath: backup?.backupPath,
      dryRun: false,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      summary: `Write failed after backup: ${e.message}. Original file is preserved${backup ? ` at ${backup.backupPath}` : ""}.`,
      error: e.message,
      backupPath: backup?.backupPath,
      dryRun: false,
    };
  }
}

/**
 * Cache janitor — deletes oldest preview files when total cache size exceeds
 * MAX_CACHE_BYTES (100 MiB default).
 *
 * Walks `<cacheRoot>/dry-run/`, sorts entries by mtime ascending, and
 * deletes oldest until total size is under the limit.
 */
async function janitCache(): Promise<void> {
  const cacheDir = path.join(cacheRoot(), "dry-run");
  const entries = await listDir(cacheDir);
  if (entries.length === 0) return;

  // Stat each entry to get size + mtime.
  const stats: Array<{ name: string; size: number; mtime: number }> = [];
  let totalSize = 0;
  for (const name of entries) {
    const filePath = path.join(cacheDir, name);
    const stat = await safeStat(filePath);
    if (!stat || !stat.isFile()) continue;
    stats.push({ name, size: stat.size, mtime: stat.mtimeMs });
    totalSize += stat.size;
  }

  if (totalSize <= MAX_CACHE_BYTES) return;

  // Sort oldest first.
  stats.sort((a, b) => a.mtime - b.mtime);

  // Delete oldest until we're under 90% of the limit (hysteresis).
  const target = Math.floor(MAX_CACHE_BYTES * 0.9);
  let deleted = 0;
  for (const entry of stats) {
    if (totalSize <= target) break;
    try {
      await fs.rm(path.join(cacheDir, entry.name), { force: true });
      totalSize -= entry.size;
      deleted++;
    } catch {
      // ignore individual file delete failures
    }
  }
}

/**
 * Truncate a string payload if it exceeds MAX_TOOL_RESULT_BYTES.
 * Used by the server to prevent oversized tool results from DoSing the
 * AI client's context window.
 *
 * Returns the truncated string + a marker if truncation happened.
 */
export function truncateForToolResult(payload: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(payload, "utf-8") <= MAX_TOOL_RESULT_BYTES) {
    return { text: payload, truncated: false };
  }
  // Truncate at byte boundary, then back off to a UTF-8 char boundary.
  const buf = Buffer.from(payload, "utf-8").subarray(0, MAX_TOOL_RESULT_BYTES - 200);
  const text = buf.toString("utf-8") + "\n\n[... truncated: payload exceeded 1 MiB limit ...]";
  return { text, truncated: true };
}
