/**
 * Schema validation — lightweight structural checks against the normalized
 * `EditorProject` shape, plus vendor-format guards for CapCut draft_content.json
 * and OpenCut project JSON.
 *
 * Validation throws a `ValidationError` with a human-readable message when a
 * file is structurally wrong. The MCP server treats any validation failure as
 * a hard refuse-to-write.
 */

import type { EditorProject, Track, Clip, Material } from "../adapters/types.js";

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly expected: string,
    readonly actual?: unknown,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Validate that `obj` looks like a CapCut draft_content.json root. */
export function assertCapcutDraft(obj: unknown, filePath: string): void {
  if (typeof obj !== "object" || obj === null) {
    throw new ValidationError("CapCut draft root must be an object", filePath, "object", typeof obj);
  }
  const root = obj as Record<string, unknown>;
  if (!Array.isArray(root.tracks)) {
    throw new ValidationError("CapCut draft missing `tracks` array", filePath, "array", typeof root.tracks);
  }
  if (!Array.isArray(root.materials)) {
    throw new ValidationError("CapCut draft missing `materials` object/array", filePath, "array", typeof root.materials);
  }
  // id + duration are typically present but optional in some versions.
  if (root.id !== undefined && typeof root.id !== "string") {
    throw new ValidationError("CapCut draft `id` must be a string", filePath, "string", typeof root.id);
  }
}

/** Validate that `obj` looks like an OpenCut project JSON root. */
export function assertOpencutProject(obj: unknown, filePath: string): void {
  if (typeof obj !== "object" || obj === null) {
    throw new ValidationError("OpenCut project root must be an object", filePath, "object", typeof obj);
  }
  const root = obj as Record<string, unknown>;
  if (typeof root.version !== "string" && typeof root.schema !== "string") {
    // Not all OpenCut builds tag a schema; warn-soft: allow but record.
  }
  if (!Array.isArray(root.tracks) && !Array.isArray(root.timeline)) {
    throw new ValidationError(
      "OpenCut project must have `tracks` or `timeline` array",
      filePath,
      "array",
      root.tracks === undefined ? "undefined" : typeof root.tracks,
    );
  }
}

/** Validate a normalized EditorProject before writing. */
export function assertValidProject(p: EditorProject): void {
  if (!p.id) throw new ValidationError("project.id is empty", p.filePath, "non-empty string");
  if (!p.name) throw new ValidationError("project.name is empty", p.filePath, "non-empty string");
  if (p.duration < 0) throw new ValidationError("project.duration negative", p.filePath, ">=0", p.duration);
  if (p.width <= 0 || p.height <= 0) throw new ValidationError("project canvas must be >0", p.filePath, "positive", `${p.width}x${p.height}`);
  if (p.fps <= 0) throw new ValidationError("project.fps must be >0", p.filePath, "positive", p.fps);

  const seenClipIds = new Set<string>();
  const seenMaterialIds = new Set<string>();
  for (const m of p.materials) {
    if (!m.id) throw new ValidationError("material.id missing", p.filePath, "string");
    if (seenMaterialIds.has(m.id)) throw new ValidationError(`duplicate material id ${m.id}`, p.filePath, "unique id");
    seenMaterialIds.add(m.id);
  }
  for (const t of p.tracks) {
    assertTrack(t, p.filePath, seenClipIds, seenMaterialIds);
  }
}

function assertTrack(t: Track, filePath: string, clipIds: Set<string>, materialIds: Set<string>): void {
  if (!t.id) throw new ValidationError("track.id missing", filePath, "string");
  // Sort clips by targetStart to check overlap.
  const sorted = [...t.clips].sort((a, b) => a.targetStart - b.targetStart);
  let lastEnd = 0;
  for (const c of sorted) {
    if (!c.id) throw new ValidationError("clip.id missing", filePath, "string");
    if (clipIds.has(c.id)) throw new ValidationError(`duplicate clip id ${c.id}`, filePath, "unique id");
    clipIds.add(c.id);
    if (!materialIds.has(c.materialId)) {
      throw new ValidationError(`clip ${c.id} references unknown material ${c.materialId}`, filePath, "existing material", c.materialId);
    }
    if (c.targetStart < lastEnd) {
      throw new ValidationError(
        `clip ${c.id} overlaps previous clip on track ${t.id}`,
        filePath,
        "non-overlapping clips",
        `${c.targetStart} < ${lastEnd}`,
      );
    }
    if (c.targetEnd < c.targetStart) {
      throw new ValidationError(`clip ${c.id} end<start`, filePath, "end>=start", `${c.targetEnd}<${c.targetStart}`);
    }
    lastEnd = c.targetEnd;
  }
}

/** Generic helper — asserts the value matches a Zod-like predicate (we use plain TS guards to avoid zod overhead on hot paths). */
export function assertMaterial(m: unknown): asserts m is Material {
  if (typeof m !== "object" || m === null) {
    throw new ValidationError("material is not an object", "(unknown)", "Material");
  }
  const mm = m as Partial<Material>;
  if (!mm.id || !mm.sourcePath) {
    throw new ValidationError("material missing id or sourcePath", "(unknown)", "Material");
  }
}

/** Generic helper — asserts the value matches a Clip. */
export function assertClip(c: unknown): asserts c is Clip {
  if (typeof c !== "object" || c === null) {
    throw new ValidationError("clip is not an object", "(unknown)", "Clip");
  }
  const cc = c as Partial<Clip>;
  if (!cc.id || !cc.materialId) {
    throw new ValidationError("clip missing id or materialId", "(unknown)", "Clip");
  }
  if (typeof cc.targetStart !== "number" || typeof cc.targetEnd !== "number") {
    throw new ValidationError("clip missing targetStart/targetEnd numbers", "(unknown)", "Clip");
  }
}
