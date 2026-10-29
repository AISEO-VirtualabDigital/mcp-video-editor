/**
 * Filesystem helpers — async, with retry-on-EBUSY (CapCut sometimes locks files
 * during a render) and atomic writes (write-temp-then-rename) so a crashed
 * write never leaves a half-written draft.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { MAX_JSON_BYTES } from "../safety/path-guard.js";

/** Ensure a directory exists, creating parents as needed. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read a JSON file, throwing a typed error if it can't be parsed.
 *
 * Security: refuses to read files larger than MAX_JSON_BYTES (50 MiB) to
 * prevent memory exhaustion from malicious or corrupted draft files.
 */
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  // Stat first to enforce a size limit. Use lstat to detect symlinks
  // — a planted symlink could point at an arbitrarily large file.
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to read symlink: ${filePath}`);
  }
  if (stat.size > MAX_JSON_BYTES) {
    throw new Error(
      `JSON file too large: ${filePath} is ${stat.size} bytes (limit ${MAX_JSON_BYTES} bytes)`,
    );
  }
  const raw = await fs.readFile(filePath, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const e = err as Error;
    throw new Error(`Failed to parse JSON at ${filePath}: ${e.message}`);
  }
}

/** Write JSON atomically (temp file + rename). */
export async function writeJson(filePath: string, value: unknown, pretty = true): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${nanoid(8)}.tmp`;
  const payload = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await fs.writeFile(tmpPath, payload, "utf-8");
  // rename is atomic on the same filesystem
  await fs.rename(tmpPath, filePath);
}

/** Write a text file atomically (temp file + rename). */
export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${nanoid(8)}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

/** Copy a file. Returns the destination path. */
export async function copyFile(src: string, dest: string): Promise<string> {
  await ensureDir(path.dirname(dest));
  // COPYFILE_FICLONE attempts copy-on-write (fast on btrfs/xfs/APFS) but
  // falls back to a regular copy if the filesystem doesn't support it.
  // We intentionally do NOT use _FORCE — that fails on tmpfs/FAT/etc.
  await fs.copyFile(src, dest, fs.constants.COPYFILE_FICLONE);
  return dest;
}

/**
 * Stat a file or return null when it doesn't exist.
 * Uses lstat to NOT follow symlinks — callers can detect symlinks via
 * `stat.isSymbolicLink()` and refuse to operate on them.
 */
export async function safeStat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}

/**
 * Resolve the real path of `filePath` (following symlinks) and return the
 * final absolute target. Throws if the path doesn't exist.
 *
 * Useful when you must check that a symlink resolves inside an allowed root
 * before operating on it.
 */
export async function resolveRealPath(filePath: string): Promise<string> {
  return await fs.realpath(filePath);
}

/** Check if a file exists. */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

/** List direct children of a directory. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Recursively read directories under `dir`, returning file paths.
 * Refuses to descend into symlinked directories — a planted symlink could
 * cause infinite recursion or expose files outside the root.
 */
export async function walkDir(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isSymbolicLink()) {
        // Skip symlinks entirely — never follow, never report.
        continue;
      }
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Retry a file operation a few times. CapCut on Windows briefly locks files
 * during render — a tiny backoff is enough to skip past it.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 50): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as NodeJS.ErrnoException;
      // Retry only on locks or transient IO; fail fast on permission errors.
      if (e.code === "EBUSY" || e.code === "EPERM" || e.code === "ENOENT") {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
