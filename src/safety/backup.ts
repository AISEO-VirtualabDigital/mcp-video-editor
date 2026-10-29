/**
 * Backup manager — copies any file we are about to overwrite into a timestamped
 * path under `backupsRoot()`. Backups are never auto-deleted.
 *
 * Layout:
 *   ~/.mcp-video-editor/backups/<YYYY-MM-DD>/<HHmmss>__<basename>.<rand>.bak
 */

import path from "node:path";
import { copyFile, ensureDir, safeStat } from "../utils/fs.js";
import { backupsRoot } from "../utils/paths.js";
import { nowIso } from "../utils/id.js";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";

export interface BackupResult {
  backupPath: string;
  /** Size in bytes of the original file (0 if it didn't exist). */
  originalSize: number;
  at: string;
}

/**
 * Create a backup of `filePath`. If the file doesn't exist yet, returns null
 * (nothing to back up — this is a fresh write).
 */
export async function backupFile(filePath: string): Promise<BackupResult | null> {
  const stat = await safeStat(filePath);
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to back up non-file or symlink: ${filePath}`);
  }

  const iso = nowIso();
  const [date, time] = iso.split("T");
  const timeSafe = time.split(".")[0].replace(/:/g, "");
  const base = path.basename(filePath);
  const dir = path.join(backupsRoot(), date);
  const dest = path.join(dir, `${timeSafe}__${base}.${nanoid(6)}.bak`);

  await ensureDir(dir);
  await copyFile(filePath, dest);

  return {
    backupPath: dest,
    originalSize: stat.size,
    at: iso,
  };
}

/** Create a recursive backup of a directory, refusing to follow symlinks. */
export async function backupDirectory(dirPath: string): Promise<BackupResult> {
  const stat = await fs.lstat(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to back up non-directory or symlink: ${dirPath}`);
  }

  const iso = nowIso();
  const [date, time] = iso.split("T");
  const timeSafe = time.split(".")[0].replace(/:/g, "");
  const backupPath = path.join(
    backupsRoot(),
    date,
    `${timeSafe}__${path.basename(dirPath)}.${nanoid(6)}.bak`,
  );
  await ensureDir(backupPath);

  let originalSize = 0;
  const copyContents = async (source: string, destination: string): Promise<void> => {
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const sourceEntry = path.join(source, entry.name);
      const destinationEntry = path.join(destination, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to back up symlink inside project: ${sourceEntry}`);
      }
      if (entry.isDirectory()) {
        await ensureDir(destinationEntry);
        await copyContents(sourceEntry, destinationEntry);
      } else if (entry.isFile()) {
        const entryStat = await fs.lstat(sourceEntry);
        if (entryStat.isSymbolicLink()) {
          throw new Error(`Refusing to back up symlink inside project: ${sourceEntry}`);
        }
        await copyFile(sourceEntry, destinationEntry);
        originalSize += entryStat.size;
      } else {
        throw new Error(`Refusing to back up unsupported filesystem entry: ${sourceEntry}`);
      }
    }
  };

  try {
    await copyContents(dirPath, backupPath);
  } catch (error) {
    await fs.rm(backupPath, { recursive: true, force: true });
    throw error;
  }

  return { backupPath, originalSize, at: iso };
}
