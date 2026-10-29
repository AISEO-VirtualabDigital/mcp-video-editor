/**
 * OpenCut adapter.
 *
 * OpenCut (https://github.com/OpenCut-Editor/opencut) is a web-based open
 * source video editor. Its project file format is JSON. As of writing there
 * isn't a single canonical schema — different versions have shipped slightly
 * different shapes — so this adapter tolerates either `tracks` (flat array of
 * tracks each with `clips`) or `timeline.tracks` (nested). The writer always
 * emits the flat form, which OpenCut ≥0.5 reads.
 *
 * Shape we write out:
 *
 *   {
 *     "version": "0.5",
 *     "id": "<project id>",
 *     "name": "<project name>",
 *     "duration": 12_345_000,
 *     "width": 1920,
 *     "height": 1080,
 *     "fps": 30,
 *     "tracks": [
 *       {
 *         "id": "<track-uuid>",
 *         "kind": "video"|"audio"|"text"|"sticker"|"effect",
 *         "clips": [
 *           {
 *             "id": "<clip-uuid>",
 *             "materialId": "<material id>",
 *             "sourceIn": 0,
 *             "sourceOut": 5_000_000,
 *             "targetStart": 0,
 *             "targetEnd": 5_000_000
 *           }
 *         ]
 *       }
 *     ],
 *     "materials": [
 *       { "id":"...", "type":"video", "sourcePath": "...", "duration": ..., "width": ..., "height": ... }
 *     ],
 *     "texts": [...],
 *     "effects": [...]
 *   }
 *
 * All durations in microseconds to stay unit-compatible with CapCut.
 */

import type {
  EditorProject,
  Material,
  Track,
  Clip,
  TextOverlay,
  EffectRef,
  EditorKind,
} from "./types.js";
import { opencutProjectPath, opencutProjectsRoot } from "../utils/paths.js";
import { readJson, writeJson, listDir, safeStat, ensureDir } from "../utils/fs.js";
import { assertOpencutProject, assertValidProject, ValidationError } from "../safety/validator.js";
import { uid } from "../utils/id.js";
import { toRawBag } from "./raw.js";

interface OpenCutProject {
  version?: string;
  schema?: string;
  id?: string;
  name?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  tracks?: OpenCutTrack[];
  timeline?: { tracks?: OpenCutTrack[] };
  materials?: OpenCutMaterial[];
  texts?: OpenCutText[];
  effects?: OpenCutEffect[];
  [k: string]: unknown;
}

interface OpenCutTrack {
  id: string;
  kind?: string;
  type?: string;
  clips?: OpenCutClip[];
  volume?: number;
  visible?: boolean;
  [k: string]: unknown;
}

interface OpenCutClip {
  id: string;
  materialId?: string;
  material_id?: string;
  sourceIn?: number;
  sourceOut?: number;
  targetStart?: number;
  targetEnd?: number;
  [k: string]: unknown;
}

interface OpenCutMaterial {
  id: string;
  type?: "video" | "audio" | "image" | "text" | "sticker";
  sourcePath?: string;
  path?: string;
  duration?: number;
  width?: number;
  height?: number;
  [k: string]: unknown;
}

interface OpenCutText {
  id: string;
  start?: number;
  end?: number;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  x?: number;
  y?: number;
  [k: string]: unknown;
}

interface OpenCutEffect {
  id: string;
  type?: string;
  start?: number;
  end?: number;
  params?: Record<string, unknown>;
  [k: string]: unknown;
}

/** List all OpenCut projects on disk. */
export async function listOpencutProjects(): Promise<
  Array<{ id: string; name: string; duration: number; updatedAt: string; filePath: string }>
> {
  const root = opencutProjectsRoot();
  const entries = await listDir(root);
  const out: Array<{ id: string; name: string; duration: number; updatedAt: string; filePath: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = `${root}/${entry}`;
    const stat = await safeStat(filePath);
    if (!stat) continue;
    const id = entry.replace(/\.json$/, "");
    let name = id;
    let duration = 0;
    try {
      const proj = await readJson<OpenCutProject>(filePath);
      name = proj.name ?? id;
      duration = proj.duration ?? 0;
    } catch {
      // ignore unparseable
    }
    out.push({ id, name, duration, updatedAt: stat.mtime.toISOString(), filePath });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

/** Read an OpenCut project and normalize to EditorProject. */
export async function readOpencutProject(projectId: string): Promise<EditorProject> {
  const filePath = opencutProjectPath(projectId);
  const stat = await safeStat(filePath);
  if (!stat) {
    throw new Error(`OpenCut project not found: ${projectId} (looked at ${filePath})`);
  }
  const raw = await readJson<OpenCutProject>(filePath);
  assertOpencutProject(raw, filePath);

  const tracksRaw = raw.tracks ?? raw.timeline?.tracks ?? [];
  const materialsRaw = raw.materials ?? [];
  const textsRaw = raw.texts ?? [];
  const effectsRaw = raw.effects ?? [];

  const materials: Material[] = materialsRaw.map((m) => ({
    id: m.id,
    type: m.type ?? "video",
    sourcePath: m.sourcePath ?? m.path ?? "",
    duration: m.duration ?? 0,
    width: m.width ?? 0,
    height: m.height ?? 0,
    raw: { ...m },
  }));

  const tracks: Track[] = tracksRaw.map((t) => ({
    id: t.id,
    kind: normalizeTrackKind(t.kind ?? t.type ?? "video"),
    clips: (t.clips ?? []).map<Clip>((c) => ({
      id: c.id,
      materialId: c.materialId ?? c.material_id ?? "",
      sourceIn: c.sourceIn ?? 0,
      sourceOut: c.sourceOut ?? 0,
      targetStart: c.targetStart ?? 0,
      targetEnd: c.targetEnd ?? 0,
      raw: { ...c },
    })),
    volume: typeof t.volume === "number" ? t.volume : undefined,
    visible: typeof t.visible === "boolean" ? t.visible : undefined,
    raw: { ...t },
  }));

  const texts: TextOverlay[] = textsRaw.map((t) => ({
    id: t.id,
    start: t.start ?? 0,
    end: t.end ?? 0,
    text: t.text ?? "",
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    color: t.color,
    backgroundColor: t.backgroundColor,
    bold: t.bold,
    italic: t.italic,
    x: t.x,
    y: t.y,
    raw: { ...t },
  }));

  const effects: EffectRef[] = effectsRaw.map((e) => ({
    id: e.id,
    type: e.type ?? "unknown",
    start: e.start ?? 0,
    end: e.end ?? 0,
    params: e.params,
    raw: { ...e },
  }));

  const project: EditorProject = {
    id: raw.id ?? projectId,
    name: raw.name ?? projectId,
    editor: "opencut",
    filePath,
    duration: raw.duration ?? 0,
    width: raw.width ?? 0,
    height: raw.height ?? 0,
    fps: raw.fps ?? 30,
    tracks,
    materials,
    texts,
    effects,
    raw: toRawBag(raw),
  };
  assertValidProject(project);
  return project;
}

function normalizeTrackKind(t: string): Track["kind"] {
  switch (t) {
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "text":
      return "text";
    case "sticker":
      return "sticker";
    case "effect":
      return "effect";
    default:
      return "video";
  }
}

/** Write an EditorProject back as OpenCut JSON. */
export async function writeOpencutProject(project: EditorProject): Promise<void> {
  await writeJson(project.filePath, buildOpencutProject(project));
}

/** Build the OpenCut document from a normalized project. */
export function buildOpencutProject(project: EditorProject): OpenCutProject {
  assertValidProject(project);
  if (project.editor !== "opencut") {
    throw new ValidationError(`writeOpencutProject called on a ${project.editor} project`, project.filePath, "opencut");
  }
  // Preserve unmodelled vendor fields: start from the cached root bag so keys we
  // do not model survive the round-trip (CapCut already did this; OpenCut did not).
  const raw: OpenCutProject = {
    ...(toRawBag(project.raw) as unknown as OpenCutProject),
    version: "0.5",
    id: project.id,
    name: project.name,
    duration: project.duration,
    width: project.width,
    height: project.height,
    fps: project.fps,
    tracks: project.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      clips: t.clips.map((c) => ({
        id: c.id,
        materialId: c.materialId,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        targetStart: c.targetStart,
        targetEnd: c.targetEnd,
        ...(typeof c.volume === "number" ? { volume: c.volume } : {}),
        ...(typeof c.speed === "number" ? { speed: c.speed } : {}),
        ...(c.raw ?? {}),
      })),
      ...(typeof t.volume === "number" ? { volume: t.volume } : {}),
      ...(typeof t.visible === "boolean" ? { visible: t.visible } : {}),
      ...(t.raw ?? {}),
    })),
    materials: project.materials.map((m) => ({
      id: m.id,
      type: m.type,
      sourcePath: m.sourcePath,
      duration: m.duration,
      width: m.width,
      height: m.height,
      ...(m.raw ?? {}),
    })),
    texts: project.texts.map((t) => ({
      id: t.id,
      start: t.start,
      end: t.end,
      text: t.text,
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      color: t.color,
      backgroundColor: t.backgroundColor,
      bold: t.bold,
      italic: t.italic,
      x: t.x,
      y: t.y,
      ...(t.raw ?? {}),
    })),
    effects: project.effects.map((e) => ({
      id: e.id,
      type: e.type,
      start: e.start,
      end: e.end,
      params: e.params,
      ...(e.raw ?? {}),
    })),
  };
  return raw;
}

/** Create a new empty OpenCut project. Returns the new project id. */
export async function createOpencutProject(
  name: string,
  opts?: { width?: number; height?: number; fps?: number },
): Promise<string> {
  const id = uid("proj_");
  await ensureDir(opencutProjectsRoot());
  const project: OpenCutProject = {
    version: "0.5",
    id,
    name,
    duration: 0,
    width: opts?.width ?? 1920,
    height: opts?.height ?? 1080,
    fps: opts?.fps ?? 30,
    tracks: [],
    materials: [],
    texts: [],
    effects: [],
  };
  await writeJson(opencutProjectPath(id), project);
  return id;
}

export const editorKind: EditorKind = "opencut";
