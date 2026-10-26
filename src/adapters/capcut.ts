/**
 * CapCut adapter.
 *
 * CapCut (Windows desktop) stores each draft as a folder under
 *   %LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<draft_id>\
 * containing `draft_content.json` (the timeline) and `draft_meta_info.json`
 * (display name, duration, etc.).
 *
 * `draft_content.json` shape (simplified — CapCut's full schema is large and
 * version-flux, so we preserve unknown fields in `raw` for round-trip fidelity):
 *
 *   {
 *     "id": "<draft id>",
 *     "duration": 12_345_000,           // microseconds
 *     "canvas_config": { "width": 1920, "height": 1080, "ratio": "original" },
 *     "fps": 30,
 *     "tracks": [
 *       {
 *         "id": "<track-uuid>",
 *         "type": "video"|"audio"|"text"|"sticker"|"effect",
 *         "segments": [
 *           {
 *             "id": "<seg-uuid>",
 *             "material_id": "<material id in materials.videos etc.>",
 *             "target_timerange": { "start": 0, "duration": 5_000_000 },
 *             "source_timerange": { "start": 1_000_000, "duration": 5_000_000 },
 *             "source": ...,                  // reference to source file
 *             "common_keyframes": [...],
 *             "extra_material_refs": [...],
 *             ...
 *           }
 *         ]
 *       }
 *     ],
 *     "materials": {
 *       "videos":  [{ "id":..., "path":..., "duration":..., "width":..., "height":..., ... }],
 *       "audios":   [{ "id":..., "path":..., "duration":..., ... }],
 *       "images":   [{ "id":..., "path":..., ... }],
 *       "texts":    [{ "id":..., "text":..., "font_path":..., "font_size":..., ... }],
 *       "stickers": [...],
 *       ...
 *     },
 *     "effects":   [...],
 *     "transitions": [...],
 *     "filters":    [...],
 *     ...
 *   }
 *
 * We normalize to the `EditorProject` shape on read and re-emit a CapCut-shaped
 * object on write. Unknown fields round-trip through `raw`.
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
import { capcutDraftContentPath, capcutDraftMetaPath, capcutDraftsRoot } from "../utils/paths.js";
import { readJson, writeJson, listDir, safeStat, ensureDir } from "../utils/fs.js";
import { assertCapcutDraft, assertValidProject, ValidationError } from "../safety/validator.js";
import { uid } from "../utils/id.js";

interface CapcutTrack {
  id: string;
  type: string;
  segments?: CapcutSegment[];
  volume?: number;
  visible?: boolean;
  [k: string]: unknown;
}

interface CapcutSegment {
  id: string;
  material_id: string;
  material_type?: string; // not always set; inferred from track.type when missing
  target_timerange?: { start: number; duration: number };
  source_timerange?: { start: number; duration: number };
  source?: { media_path?: string };
  common_keyframes?: unknown[];
  extra_material_refs?: string[];
  [k: string]: unknown;
}

interface CapcutMaterials {
  videos?: CapcutMaterial[];
  audios?: CapcutMaterial[];
  images?: CapcutMaterial[];
  texts?: CapcutMaterial[];
  stickers?: CapcutMaterial[];
  [k: string]: unknown;
}

interface CapcutMaterial {
  id: string;
  path?: string;
  media_path?: string;
  duration?: number;
  width?: number;
  height?: number;
  text?: string;
  font_path?: string;
  font_size?: number;
  text_color?: string;
  background_color?: string;
  bold?: boolean;
  italic?: boolean;
  [k: string]: unknown;
}

interface CapcutDraft {
  id?: string;
  duration?: number;
  canvas_config?: { width?: number; height?: number; ratio?: string };
  fps?: number;
  tracks: CapcutTrack[];
  materials: CapcutMaterials;
  effects?: CapcutEffect[];
  [k: string]: unknown;
}

interface CapcutEffect {
  id: string;
  type?: string;
  range?: { start: number; duration: number };
  [k: string]: unknown;
}

/** Return CapCut draft metadata for every draft on disk. */
export async function listCapcutDrafts(): Promise<
  Array<{ id: string; name: string; duration: number; updatedAt: string; folder: string }>
> {
  const root = capcutDraftsRoot();
  const entries = await listDir(root);
  const out: Array<{ id: string; name: string; duration: number; updatedAt: string; folder: string }> = [];
  for (const id of entries) {
    const folder = `${root}/${id}`;
    const stat = await safeStat(folder);
    if (!stat || !stat.isDirectory()) continue;
    const metaPath = capcutDraftMetaPath(id);
    const metaStat = await safeStat(metaPath);
    if (!metaStat) continue;
    let meta: Record<string, unknown> = {};
    try {
      meta = await readJson<Record<string, unknown>>(metaPath);
    } catch {
      // ignore unparseable meta
    }
    out.push({
      id,
      name: (meta.draft_name as string) ?? (meta.name as string) ?? id,
      duration: (meta.duration as number) ?? 0,
      updatedAt: metaStat.mtime.toISOString(),
      folder,
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

/** Read a CapCut draft and normalize it to an EditorProject. */
export async function readCapcutDraft(draftId: string): Promise<EditorProject> {
  const contentPath = capcutDraftContentPath(draftId);
  const stat = await safeStat(contentPath);
  if (!stat) {
    throw new Error(`CapCut draft not found: ${draftId} (looked at ${contentPath})`);
  }
  const raw = await readJson<CapcutDraft>(contentPath);
  assertCapcutDraft(raw, contentPath);

  const materials: Material[] = [];
  const materialTypeIndex = new Map<string, "video" | "audio" | "image" | "text" | "sticker">();
  for (const kind of ["videos", "audios", "images", "texts", "stickers"] as const) {
    const arr = raw.materials[kind] ?? [];
    const mapped: Material["type"] =
      kind === "videos" ? "video" : kind === "audios" ? "audio" : kind === "images" ? "image" : kind === "texts" ? "text" : "sticker";
    for (const m of arr) {
      const src = m.media_path ?? m.path ?? "";
      const mat: Material = {
        id: m.id,
        type: mapped,
        sourcePath: src,
        duration: m.duration ?? 0,
        width: m.width ?? 0,
        height: m.height ?? 0,
        raw: { ...m },
      };
      materials.push(mat);
      materialTypeIndex.set(m.id, mapped);
    }
  }

  const tracks: Track[] = (raw.tracks ?? []).map((t) => {
    const kind = normalizeTrackKind(t.type);
    const clips: Clip[] = (t.segments ?? []).map((s) => {
      const targetStart = s.target_timerange?.start ?? 0;
      const targetDur = s.target_timerange?.duration ?? 0;
      const sourceStart = s.source_timerange?.start ?? 0;
      const sourceDur = s.source_timerange?.duration ?? targetDur;
      return {
        id: s.id,
        materialId: s.material_id,
        sourceIn: sourceStart,
        sourceOut: sourceStart + sourceDur,
        targetStart,
        targetEnd: targetStart + targetDur,
        raw: { ...s },
      };
    });
    return {
      id: t.id,
      kind,
      clips,
      volume: typeof t.volume === "number" ? t.volume : undefined,
      visible: typeof t.visible === "boolean" ? t.visible : undefined,
      raw: { ...t },
    };
  });

  const texts: TextOverlay[] = [];
  const textMaterials = raw.materials.texts ?? [];
  for (const tm of textMaterials) {
    // Find a segment referencing this text material to find timeline window.
    let start = 0;
    let end = 0;
    for (const t of tracks) {
      if (t.kind !== "text") continue;
      for (const c of t.clips) {
        if (c.materialId === tm.id) {
          start = c.targetStart;
          end = c.targetEnd;
          break;
        }
      }
    }
    texts.push({
      id: tm.id,
      start,
      end,
      text: tm.text ?? "",
      fontFamily: tm.font_path,
      fontSize: tm.font_size,
      color: tm.text_color,
      backgroundColor: tm.background_color,
      bold: tm.bold,
      italic: tm.italic,
      raw: { ...tm },
    });
  }

  const effects: EffectRef[] = (raw.effects ?? []).map((e) => {
    const start = e.range?.start ?? 0;
    const dur = e.range?.duration ?? 0;
    return {
      id: e.id,
      type: e.type ?? "unknown",
      start,
      end: start + dur,
      raw: { ...e },
    };
  });

  const project: EditorProject = {
    id: raw.id ?? draftId,
    name: await readDraftName(draftId),
    editor: "capcut",
    filePath: contentPath,
    duration: raw.duration ?? 0,
    width: raw.canvas_config?.width ?? 0,
    height: raw.canvas_config?.height ?? 0,
    fps: raw.fps ?? 30,
    tracks,
    materials,
    texts,
    effects,
    raw: raw as unknown as Record<string, unknown>,
  };
  assertValidProject(project);
  return project;
}

async function readDraftName(draftId: string): Promise<string> {
  const metaPath = capcutDraftMetaPath(draftId);
  try {
    const meta = await readJson<Record<string, unknown>>(metaPath);
    return (meta.draft_name as string) ?? (meta.name as string) ?? draftId;
  } catch {
    return draftId;
  }
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

/**
 * Write an EditorProject back to CapCut draft_content.json. We re-emit a
 * CapCut-shaped object by starting from the cached `raw` and updating tracks,
 * materials, and known fields. Unknown fields round-trip unchanged.
 */
export async function writeCapcutDraft(project: EditorProject): Promise<void> {
  assertValidProject(project);
  if (project.editor !== "capcut") {
    throw new ValidationError(`writeCapcutDraft called on a ${project.editor} project`, project.filePath, "capcut");
  }
  const raw: CapcutDraft = (project.raw ? { ...(project.raw as CapcutDraft) } : { tracks: [], materials: {} }) as CapcutDraft;
  raw.id = project.id;
  raw.duration = project.duration;
  raw.fps = project.fps;
  raw.canvas_config = {
    width: project.width,
    height: project.height,
    ratio: "original",
  };

  // Rebuild tracks
  raw.tracks = project.tracks.map((t) => {
    const segments: CapcutSegment[] = t.clips.map((c) => {
      const seg: CapcutSegment = {
        id: c.id,
        material_id: c.materialId,
        material_type: inferMaterialType(c.materialId, project.materials),
        target_timerange: { start: c.targetStart, duration: c.targetEnd - c.targetStart },
        source_timerange: { start: c.sourceIn, duration: c.sourceOut - c.sourceIn },
        ...(c.raw ?? {}),
      };
      // Apply volume override if present.
      if (typeof c.volume === "number") {
        (seg as Record<string, unknown>).volume = c.volume;
      }
      if (typeof c.speed === "number") {
        (seg as Record<string, unknown>).speed = c.speed;
      }
      return seg;
    });
    return {
      id: t.id,
      type: denormalizeTrackKind(t.kind),
      segments,
      ...(typeof t.volume === "number" ? { volume: t.volume } : {}),
      ...(typeof t.visible === "boolean" ? { visible: t.visible } : {}),
      ...(t.raw ?? {}),
    };
  });

  // Rebuild materials — emit empty arrays when no materials.
  const mats: CapcutMaterials = {
    videos: [],
    audios: [],
    images: [],
    texts: [],
    stickers: [],
    ...(raw.materials ?? {}),
  };
  for (const m of project.materials) {
    const cap: CapcutMaterial = m.raw
      ? ({ ...m.raw } as CapcutMaterial)
      : ({ id: m.id, path: m.sourcePath, duration: m.duration, width: m.width, height: m.height } as CapcutMaterial);
    cap.id = m.id;
    cap.path = m.sourcePath;
    cap.duration = m.duration;
    cap.width = m.width;
    cap.height = m.height;
    switch (m.type) {
      case "video":
        mats.videos!.push(cap);
        break;
      case "audio":
        mats.audios!.push(cap);
        break;
      case "image":
        mats.images!.push(cap);
        break;
      case "text":
        mats.texts!.push(cap);
        break;
      case "sticker":
        mats.stickers!.push(cap);
        break;
    }
  }
  raw.materials = mats;

  // Rebuild effects
  raw.effects = project.effects.map((e) => ({
    id: e.id,
    type: e.type,
    range: { start: e.start, duration: e.end - e.start },
    ...(e.params ?? {}),
    ...(e.raw ?? {}),
  }));

  await writeJson(project.filePath, raw);
}

function inferMaterialType(
  id: string,
  materials: Material[],
): "video" | "audio" | "image" | "text" | "sticker" | undefined {
  const m = materials.find((x) => x.id === id);
  return m?.type;
}

function denormalizeTrackKind(k: Track["kind"]): string {
  return k;
}

/** Create a new empty CapCut draft. Returns the new draft id. */
export async function createCapcutDraft(name: string, opts?: { width?: number; height?: number; fps?: number }): Promise<string> {
  const draftId = uid("draft_");
  const folder = `${capcutDraftsRoot()}/${draftId}`;
  await ensureDir(folder);

  const draft: CapcutDraft = {
    id: draftId,
    duration: 0,
    canvas_config: { width: opts?.width ?? 1920, height: opts?.height ?? 1080, ratio: "original" },
    fps: opts?.fps ?? 30,
    tracks: [],
    materials: { videos: [], audios: [], images: [], texts: [], stickers: [] },
    effects: [],
  };
  await writeJson(capcutDraftContentPath(draftId), draft);
  // Meta
  const meta = {
    draft_name: name,
    draft_id: draftId,
    duration: 0,
    tm_draft_create: "",
    tm_draft_modified: "",
    cover: "",
  };
  await writeJson(capcutDraftMetaPath(draftId), meta);
  return draftId;
}

export const editorKind: EditorKind = "capcut";
