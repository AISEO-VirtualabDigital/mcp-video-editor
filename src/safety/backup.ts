/**
 * Backup manager — copies any file we are about to overwrite into a timestamped
 * folder under `backupsRoot()`. Backups are never auto-deleted.
 *
 * Layout:
 *   ~/.mcp-video-editor/backups/<YYYY-MM-DD>/<HHmmss>__<basename>.<rand>.bak
 */

import path from "node:path";
import { copyFile, ensureDir, safeStat } from "../utils/fs.js";
import { backupsRoot } from "../utils/paths.js";
import { nowIso } from "../utils/id.js";
import { nanoid } from "nanoid";

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

  const iso = nowIso();
  const [date, time] = iso.split("T");
  const dateSafe = date.replace(/-/g, "-");
  const timeSafe = time.split(".")[0].replace(/:/g, "");
  const base = path.basename(filePath);
  const dir = path.join(backupsRoot(), dateSafe);
  const dest = path.join(dir, `${timeSafe}__${base}.${nanoid(6)}.bak`);

  await ensureDir(dir);
  await copyFile(filePath, dest);

  return {
    backupPath: dest,
    originalSize: stat.size,
    at: iso,
  };
}
