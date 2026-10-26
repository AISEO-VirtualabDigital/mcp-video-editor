/**
 * Path security guards.
 *
 * These functions centralize every check that prevents user-supplied input
 * (project ids, source paths, output paths) from escaping the intended
 * filesystem confinement.
 *
 * Threat model:
 *   - The MCP server runs as the local user with full filesystem permissions.
 *   - The AI client is trusted to call tools with reasonable inputs, but a
 *     prompt-injected or hostile AI can call any tool with any args.
 *   - Therefore every user-supplied identifier that ends up in a path must
 *     be validated before use, and every resolved path must be checked for
 *     containment inside the expected root.
 *
 * Defense in depth: we check IDs at the boundary (Zod schema), AND we check
 * the resolved path before any filesystem mutation. Either check alone is
 * not sufficient.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Pattern that matches a safe project/draft id.
 * Allowed: ASCII letters, digits, underscores, hyphens, dots.
 * Disallowed: slashes, backslashes, colons, spaces, control chars, `..`,
 *   leading dots, leading/trailing whitespace.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Assert that a project/draft id is structurally safe to use in a path.
 * Rejects anything containing path separators, parent-dir references,
 * null bytes, or non-printable characters.
 *
 * @throws Error if the id is unsafe.
 */
export function assertSafeProjectId(id: string, label = "id"): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Unsafe ${label}: must be a non-empty string`);
  }
  if (id.length > 256) {
    throw new Error(`Unsafe ${label}: length ${id.length} exceeds 256 chars`);
  }
  if (id.includes("\0")) {
    throw new Error(`Unsafe ${label}: contains null byte`);
  }
  if (id === "." || id === "..") {
    throw new Error(`Unsafe ${label}: cannot be "." or ".."`);
  }
  if (id.startsWith(".")) {
    throw new Error(`Unsafe ${label}: cannot start with a dot (got "${id.slice(0, 20)}")`);
  }
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(
      `Unsafe ${label}: must match /^[A-Za-z0-9_.-]+$/ (got "${id.slice(0, 40)}${id.length > 40 ? "…" : ""}")`,
    );
  }
}

/**
 * Assert that `targetPath` is contained inside `rootPath` after both are
 * resolved to absolute paths.
 *
 * Uses `path.relative()` to detect escape: if the relative path starts with
 * `..`, the target is outside the root.
 *
 * @param targetPath The path to check (typically resolved from user input).
 * @param rootPath The allowed root.
 * @param label Used in error messages.
 * @returns The resolved absolute target path (for downstream use).
 * @throws Error if targetPath escapes rootPath.
 */
export function assertPathInside(targetPath: string, rootPath: string, label = "path"): string {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path escape detected: ${label} "${targetPath}" resolves outside root "${resolvedRoot}"`,
    );
  }
  return resolvedTarget;
}

/**
 * Assert that an external source path (used by add_video_clip / add_audio_clip)
 * is structurally safe to reference from a project.
 *
 * Rules:
 *   1. Must be an absolute path (no relative paths, no `~/...`).
 *   2. Must NOT be a UNC path on Windows (`\\server\share`) — Windows will
 *      silently authenticate to remote SMB servers, which is an NTLM relay
 *      risk. If you need network sources, mount them as a drive letter first.
 *   3. Must NOT contain null bytes.
 *   4. Must NOT exceed MAX_PATH characters (Windows limit is 260 by default;
 *      we use a more generous 4096 to allow long paths on modern Windows).
 *   5. Must be inside an allowed root if `allowedRoots` is provided.
 *
 * @param sourcePath The user-supplied source file path.
 * @param allowedRoots Optional list of root directories the source must be
 *   inside. When provided, the path must be inside at least one of them.
 *   When omitted, no root confinement is enforced (use for permissive
 *   "user knows what they're doing" mode).
 * @throws Error if the path is unsafe.
 */
export function assertSafeExternalPath(
  sourcePath: string,
  allowedRoots?: string[],
): void {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error("Source path must be a non-empty string");
  }
  if (sourcePath.includes("\0")) {
    throw new Error("Source path contains null byte");
  }
  if (sourcePath.length > 4096) {
    throw new Error(`Source path too long: ${sourcePath.length} chars`);
  }
  if (!path.isAbsolute(sourcePath)) {
    throw new Error(
      `Source path must be absolute (got "${sourcePath.slice(0, 40)}…"). Resolve to absolute before calling.`,
    );
  }
  // Reject UNC paths on Windows: \\server\share OR //server/share.
  // Windows silently authenticates to SMB servers, which is an NTLM relay risk.
  if (/^\\\\[^\\]/.test(sourcePath) || /^\/\/[^/]/.test(sourcePath)) {
    throw new Error(
      `UNC paths are not allowed for security reasons (got "${sourcePath.slice(0, 40)}…"). Mount the share as a drive letter and use that path instead.`,
    );
  }
  // Reject the Windows device namespace (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  // and the \\.\ device path.
  if (/^[A-Za-z]:[\\/](CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([\.\\/]?)$/i.test(sourcePath)) {
    throw new Error(`Windows reserved device name rejected: ${sourcePath}`);
  }
  if (/^\\\\\.[\\/]/.test(sourcePath)) {
    throw new Error(`Windows device path rejected: ${sourcePath}`);
  }
  if (allowedRoots && allowedRoots.length > 0) {
    const inside = allowedRoots.some((root) => {
      try {
        assertPathInside(sourcePath, root);
        return true;
      } catch {
        return false;
      }
    });
    if (!inside) {
      throw new Error(
        `Source path "${sourcePath.slice(0, 60)}…" is not inside any allowed root`,
      );
    }
  }
}

/**
 * Refuse to follow symlinks — return the lstat result, throw if it's a symlink.
 *
 * CapCut draft folders should never contain symlinks; a planted symlink
 * pointing at /etc/passwd or C:\Windows\System32\config\SAM would let an
 * attacker read or overwrite arbitrary files.
 */
export async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink at ${filePath}`);
    }
  } catch (err) {
    // Re-throw our own error; ENOENT is fine (caller handles non-existence).
    if (err instanceof Error && err.message.startsWith("Refusing to follow symlink")) {
      throw err;
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // not exist, not a symlink
    }
    throw err;
  }
}

/**
 * Refuse if any path component in `dir` is a symlink.
 * Walks the path from root to the target and checks each ancestor.
 */
export async function assertNoSymlinkInPath(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const parts = resolved.split(path.sep);
  // Walk from root downward, lstat-ing each prefix.
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join(path.sep);
    if (!prefix) continue;
    if (!existsSync(prefix)) return; // rest of path doesn't exist yet
    try {
      const stat = await fs.lstat(prefix);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to operate on path with symlink component: ${prefix}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Refusing to operate")) throw err;
      // ignore — let the caller handle the path
    }
  }
}

/** Maximum JSON file size we'll read in one shot. 50 MiB. */
export const MAX_JSON_BYTES = 50 * 1024 * 1024;

/** Maximum cache directory size in bytes. 100 MiB. */
export const MAX_CACHE_BYTES = 100 * 1024 * 1024;

/** Maximum tool result payload size we'll send to the client. 1 MiB. */
export const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
