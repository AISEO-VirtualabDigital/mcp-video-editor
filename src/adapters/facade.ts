/**
 * Unified editor facade — tools call these functions; the right adapter is
 * picked based on the `editor` field stored in the project cache.
 *
 * The "open project" operation returns an `EditorProject` whose `editor` field
 * determines which adapter writes back.
 */

import type { EditorProject, EditorKind } from "./types.js";
import * as capcut from "./capcut.js";
import * as opencut from "./opencut.js";
import { serializeJson, writeSerialized } from "../utils/fs.js";

/** In-memory cache of currently-open projects keyed by project id. */
const openProjects = new Map<string, EditorProject>();

/** Open a CapCut or OpenCut project by id+kind. */
export async function openProject(
  id: string,
  editor: EditorKind,
): Promise<EditorProject> {
  const project =
    editor === "capcut" ? await capcut.readCapcutDraft(id) : await opencut.readOpencutProject(id);
  openProjects.set(id, project);
  return project;
}

/** Get a cached open project (throws if not opened first). */
export function getOpenProject(id: string): EditorProject {
  const p = openProjects.get(id);
  if (!p) {
    throw new Error(`Project ${id} is not open. Call open_project first.`);
  }
  return p;
}

/** Save an in-memory project back to disk. */
export async function saveProject(project: EditorProject): Promise<void> {
  await saveProjectSerialized(project, serializeProject(project));
}

/**
 * Build the vendor document for a project (CapCut draft / OpenCut project).
 * Validates first, so a broken project can never reach the disk.
 */
export function buildVendorDocument(project: EditorProject): unknown {
  return project.editor === "capcut"
    ? capcut.buildCapcutDraft(project)
    : opencut.buildOpencutProject(project);
}

/**
 * Serialize a project to JSON text.
 *
 * `JSON.stringify` is synchronous and is the only event-loop-blocking step in
 * the write path, so callers serialize ONCE and hand the payload to
 * `saveProjectSerialized` — a retry loop must never re-serialize.
 */
export function serializeProject(project: EditorProject): string {
  return serializeJson(buildVendorDocument(project));
}

/**
 * Write an already-serialized payload and refresh the cache.
 *
 * Use inside `withRetry` so only the file write is retried (EBUSY on Windows)
 * while the expensive serialization happens once.
 */
export async function saveProjectSerialized(project: EditorProject, payload: string): Promise<void> {
  await writeSerialized(project.filePath, payload);
  openProjects.set(project.id, project);
}

/** Close a project (drops it from cache; does NOT save). */
export function closeProject(id: string): void {
  openProjects.delete(id);
}

/** Create a new empty project of the given kind. Returns the new id. */
export async function createProject(
  name: string,
  editor: EditorKind,
  opts?: { width?: number; height?: number; fps?: number },
): Promise<string> {
  const id = editor === "capcut" ? await capcut.createCapcutDraft(name, opts) : await opencut.createOpencutProject(name, opts);
  return id;
}

/** List projects of a given kind on disk. */
export async function listProjects(
  editor: EditorKind,
): Promise<Array<{ id: string; name: string; duration: number; updatedAt: string; filePath: string }>> {
  if (editor === "capcut") {
    const drafts = await capcut.listCapcutDrafts();
    return drafts.map((d) => ({
      id: d.id,
      name: d.name,
      duration: d.duration,
      updatedAt: d.updatedAt,
      filePath: `${d.folder}/draft_content.json`,
    }));
  }
  return opencut.listOpencutProjects();
}

/** Replace the cached project (mutating operations call this after editing). */
export function cacheProject(project: EditorProject): void {
  openProjects.set(project.id, project);
}

/** List open project ids (useful for inspection tools). */
export function listOpenProjectIds(): string[] {
  return [...openProjects.keys()];
}
