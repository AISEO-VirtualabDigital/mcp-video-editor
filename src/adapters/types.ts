/**
 * Shared types for video-editor MCP server.
 *
 * Both CapCut draft_content.json and OpenCut project JSON are normalized to the
 * same internal `EditorProject` shape so that tool implementations can stay
 * editor-agnostic. Adapters in `src/adapters/*` are responsible for the
 * bidirectional conversion.
 */

/** Supported editor backends. */
export type EditorKind = "capcut" | "opencut";

/** A single video/audio/image material referenced by one or more clips. */
export interface Material {
  id: string;
  type: "video" | "audio" | "image" | "text" | "sticker";
  /** Absolute path or URL to the source asset. */
  sourcePath: string;
  /** Duration in microseconds (CapCut-native unit; 1_000_000 = 1s). */
  duration: number;
  /** Width in pixels (0 if unknown / not applicable). */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Free-form metadata bag (raw vendor fields preserved for round-trip fidelity). */
  raw?: Record<string, unknown>;
}

/** A clip is an instance of a material placed on a track between two time points. */
export interface Clip {
  id: string;
  materialId: string;
  /** In-point on the source material, microseconds. */
  sourceIn: number;
  /** Out-point on the source material, microseconds. */
  sourceOut: number;
  /** Target start on the timeline, microseconds. */
  targetStart: number;
  /** Target end on the timeline, microseconds. */
  targetEnd: number;
  /** Optional transition applied to the start of this clip. */
  transitionIn?: TransitionRef;
  /** Optional transition applied to the end of this clip. */
  transitionOut?: TransitionRef;
  /** Volume multiplier 0..1 for audio clips; 1 = original. */
  volume?: number;
  /** Speed multiplier; 1.0 = normal. */
  speed?: number;
  /** Raw vendor fields preserved for round-trip fidelity. */
  raw?: Record<string, unknown>;
}

export type TrackKind = "video" | "audio" | "text" | "sticker" | "effect";

export interface Track {
  id: string;
  kind: TrackKind;
  /** Ordered list of clips. EditorProject invariant: clips do not overlap on the same track. */
  clips: Clip[];
  /** Volume trim for whole track (audio only). */
  volume?: number;
  /** Visibility flag. */
  visible?: boolean;
  /** Raw vendor fields preserved for round-trip fidelity. */
  raw?: Record<string, unknown>;
}

export interface TransitionRef {
  type: string;
  duration: number;
  raw?: Record<string, unknown>;
}

export interface EffectRef {
  id: string;
  type: string;
  /** Apply window on the timeline, microseconds. */
  start: number;
  end: number;
  params?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface TextOverlay {
  id: string;
  /** Microsecond start on the timeline. */
  start: number;
  /** Microsecond end on the timeline. */
  end: number;
  text: string;
  /** Font family name (CapCut/OpenCut dependent). */
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  /** Hex color, e.g. "#FFFFFFFF". */
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  x?: number;
  y?: number;
  raw?: Record<string, unknown>;
}

/** Normalized project model. Adapters convert to/from this. */
export interface EditorProject {
  id: string;
  name: string;
  editor: EditorKind;
  /** Project file absolute path. */
  filePath: string;
  /** Total project duration in microseconds (max clip end across all tracks). */
  duration: number;
  /** Canvas width. */
  width: number;
  /** Canvas height. */
  height: number;
  /** Frames per second. */
  fps: number;
  tracks: Track[];
  materials: Material[];
  texts: TextOverlay[];
  effects: EffectRef[];
  /** Raw vendor object preserved for round-trip fidelity. */
  raw?: Record<string, unknown>;
}

/** Result returned by every tool. */
export interface ToolResult {
  ok: boolean;
  /** Human-readable summary suitable for the AI assistant. */
  summary: string;
  /** Structured payload the AI can reason over. */
  data?: unknown;
  /** Path to a backup file if a write occurred. */
  backupPath?: string;
  /** If dry-run was honored. */
  dryRun?: boolean;
  /** Error message when ok=false. */
  error?: string;
}

/** Schema for an export profile. */
export interface ExportProfile {
  width: number;
  height: number;
  fps: number;
  /** Video bitrate in bps. */
  videoBitrate: number;
  /** Audio bitrate in bps. */
  audioBitrate: number;
  format: "mp4" | "mov" | "webm";
  codec: "h264" | "h265" | "av1" | "vp9";
}

/** Default export profiles keyed by friendly name. */
export const DEFAULT_EXPORT_PROFILES: Record<string, ExportProfile> = {
  "1080p-30": { width: 1920, height: 1080, fps: 30, videoBitrate: 8_000_000, audioBitrate: 128_000, format: "mp4", codec: "h264" },
  "1080p-60": { width: 1920, height: 1080, fps: 60, videoBitrate: 12_000_000, audioBitrate: 192_000, format: "mp4", codec: "h264" },
  "4k-30": { width: 3840, height: 2160, fps: 30, videoBitrate: 35_000_000, audioBitrate: 192_000, format: "mp4", codec: "h265" },
  "4k-60": { width: 3840, height: 2160, fps: 60, videoBitrate: 50_000_000, audioBitrate: 192_000, format: "mp4", codec: "h265" },
  "720p-30": { width: 1280, height: 720, fps: 30, videoBitrate: 4_000_000, audioBitrate: 128_000, format: "mp4", codec: "h264" },
};

/** A render-progress event payload emitted via MCP notifications. */
export interface RenderProgressEvent {
  projectId: string;
  phase: "queued" | "rendering" | "complete" | "error";
  /** 0..1. */
  progress: number;
  /** Output path when phase=complete. */
  outputPath?: string;
  /** Error message when phase=error. */
  error?: string;
  /** ISO 8601 timestamp. */
  at: string;
}

/** A project-changed event payload emitted via MCP notifications. */
export interface ProjectChangedEvent {
  projectId: string;
  kind: "capcut" | "opencut";
  /** What changed. */
  change: "draft-written" | "opened" | "closed" | "saved" | "external";
  /** Path to the affected file. */
  filePath: string;
  at: string;
}
