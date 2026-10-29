/**
 * FCP7 XML (xmeml v4) exporter — the exchange format both Adobe Premiere and
 * Wondershare Filmora import natively.
 *
 *   Premiere : File > Import > the .xml  (sequence appears in the bin)
 *   Filmora  : Import > "Timeline Exchange Format XML"
 *
 * Neither editor exposes a writable project format we can round-trip:
 * Premiere has no editable project file (it needs a running app + a UXP/CEP
 * plugin), and Filmora's .wfp is undocumented. xmeml is the one format both
 * document support for, so this module is the compatibility bridge.
 *
 * Limits (reported back to the caller as warnings):
 *   - text overlays, stickers and effect references are NOT emitted
 *   - speed changes are ignored (native rate is used)
 *   - transitions are dropped
 */

import path from "node:path";
import type { Clip, EditorProject, Material, Track } from "../adapters/types.js";

export interface XmemlResult {
  xml: string;
  stats: {
    videoTracks: number;
    audioTracks: number;
    clipItems: number;
    files: number;
    durationFrames: number;
  };
  warnings: string[];
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Frame rate -> xmeml rate block. 29.97 and 23.976 are represented as
 * timebase 30/24 with ntsc TRUE, which is how FCP7 XML encodes drop-frame rates.
 */
function rateBlock(fps: number, indent: string): string {
  const near = (target: number) => Math.abs(fps - target) < 0.01;
  const ntsc = near(29.97) || near(23.976) || near(59.94);
  const timebase = ntsc ? Math.round(fps) : Math.round(fps);
  return [
    `${indent}<rate>`,
    `${indent}  <timebase>${timebase}</timebase>`,
    `${indent}  <ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc>`,
    `${indent}</rate>`,
  ].join("\n");
}

/** Absolute filesystem path -> file://localhost URL. */
function toPathUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(normalized);
  const drive = driveMatch ? `${driveMatch[1]}` : "";
  const rest = driveMatch ? driveMatch[2] ?? "/" : normalized;
  // Encode each segment so spaces, &, # and quotes survive as a real URL.
  const encoded = rest
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${drive ? `file://localhost/${drive}` : "file://localhost"}${encoded}`;
}

/**
 * Build an xmeml v4 document from a normalized project.
 *
 * @param project  normalized project (any editor)
 * @param fps      sequence frame rate; defaults to the project's fps
 */
export function buildXmeml(project: EditorProject, fps = project.fps || 30): XmemlResult {
  const warnings: string[] = [];
  const toFrames = (us: number): number => Math.round((us / 1_000_000) * fps);
  const safeFps = fps > 0 ? fps : 30;

  // Materials indexed by id so clipitems can emit a <file> reference.
  const materials = new Map<string, Material>(project.materials.map((m) => [m.id, m]));
  const fileIds = new Map<string, string>();
  const fileBodies = new Map<string, string>();
  let fileSeq = 0;
  let clipSeq = 0;
  let clipItems = 0;

  const durationUs =
    project.duration ||
    project.tracks.reduce((max, t) => Math.max(max, ...t.clips.map((c) => c.targetEnd)), 0);
  const durationFrames = toFrames(durationUs);

  /**
   * xmeml wants the full <file> definition inline on the first clipitem that
   * uses it; later clipitems reference it by id only.
   */
  function fileElementFor(material: Material): { id: string; body: string; first: boolean } | null {
    const existing = fileIds.get(material.id);
    if (existing) {
      return { id: existing, body: fileBodies.get(existing) ?? "", first: false };
    }
    if (!material.sourcePath) {
      warnings.push(`Material ${material.id} has no source path — clip dropped.`);
      return null;
    }
    const id = `file-${++fileSeq}`;
    fileIds.set(material.id, id);
    const width = material.width || project.width;
    const height = material.height || project.height;
    const isAudio = material.type === "audio";
    const body = [
      `          <file id="${id}">`,
      `            <name>${escapeXml(path.basename(material.sourcePath))}</name>`,
      `            <pathurl>${escapeXml(toPathUrl(material.sourcePath))}</pathurl>`,
      rateBlock(safeFps, "            "),
      `            <duration>${Math.max(1, toFrames(material.duration))}</duration>`,
      `            <media>`,
      isAudio
        ? `              <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></audio>`
        : `              <video><samplecharacteristics><width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`,
      `            </media>`,
      `          </file>`,
    ].join("\n");
    fileBodies.set(id, body);
    return { id, body, first: true };
  }

  function clipItem(clip: Clip, isAudio: boolean): string | null {
    const material = materials.get(clip.materialId);
    if (!material) {
      warnings.push(`Clip ${clip.id} references unknown material ${clip.materialId} — dropped.`);
      return null;
    }
    const file = fileElementFor(material);
    if (!file) return null;

    if (clip.speed !== undefined && Math.abs(clip.speed - 1) > 0.001) {
      warnings.push(`Clip ${clip.id} has speed ${clip.speed} — exported at native rate.`);
    }

    const start = toFrames(clip.targetStart);
    const end = Math.max(start + 1, toFrames(clip.targetEnd));
    const inFrame = toFrames(clip.sourceIn);
    const outFrame = Math.max(inFrame + 1, toFrames(clip.sourceOut));
    const id = `clipitem-${++clipSeq}`;
    clipItems += 1;

    const lines = [
      `        <clipitem id="${id}">`,
      `          <name>${escapeXml(path.basename(material.sourcePath))}</name>`,
      `          <duration>${Math.max(1, toFrames(material.duration))}</duration>`,
      rateBlock(safeFps, "          "),
      `          <start>${start}</start>`,
      `          <end>${end}</end>`,
      `          <in>${inFrame}</in>`,
      `          <out>${outFrame}</out>`,
      file.first ? file.body : `          <file id="${file.id}"/>`,
    ];
    if (isAudio) {
      lines.push(`          <sourcetrack>`);
      lines.push(`            <mediatype>audio</mediatype>`);
      lines.push(`            <trackindex>1</trackindex>`);
      lines.push(`          </sourcetrack>`);
      if (clip.volume !== undefined && Math.abs(clip.volume - 1) > 0.001) {
        const level = Math.round(20 * Math.log10(Math.max(clip.volume, 0.0001)) * 100) / 100;
        lines.push(`          <filter>`);
        lines.push(`            <effect>`);
        lines.push(`              <name>Audio Levels</name>`);
        lines.push(`              <effectid>audiolevels</effectid>`);
        lines.push(`              <effectcategory>audiolevels</effectcategory>`);
        lines.push(`              <effecttype>audiolevels</effecttype>`);
        lines.push(`              <mediatype>audio</mediatype>`);
        lines.push(`              <parameter>`);
        lines.push(`                <parameterid>level</parameterid>`);
        lines.push(`                <name>Level</name>`);
        lines.push(`                <value>${level}</value>`);
        lines.push(`              </parameter>`);
        lines.push(`            </effect>`);
        lines.push(`          </filter>`);
      }
    }
    lines.push(`        </clipitem>`);
    return lines.join("\n");
  }

  const videoTracks = project.tracks.filter((t) => t.kind === "video");
  const audioTracks = project.tracks.filter((t) => t.kind === "audio");
  const textTracks = project.tracks.filter((t) => t.kind === "text" || t.kind === "sticker" || t.kind === "effect");
  if (textTracks.length) {
    const clipCount = textTracks.reduce((n, t) => n + t.clips.length, 0);
    warnings.push(`${textTracks.length} text/sticker/effect track(s), ${clipCount} clip(s), are not exported to xmeml.`);
  }
  if (project.texts.length) {
    warnings.push(`${project.texts.length} text overlay(s) are not exported to xmeml — titles do not survive the exchange format.`);
  }
  if (project.effects.length) {
    warnings.push(`${project.effects.length} effect reference(s) are not exported to xmeml.`);
  }
  const transitions = project.tracks.reduce(
    (n, t) => n + t.clips.filter((c) => c.transitionIn || c.transitionOut).length,
    0,
  );
  if (transitions) {
    warnings.push(`${transitions} clip transition(s) are not exported to xmeml.`);
  }

  function trackElement(track: Track, isAudio: boolean): string | null {
    const items = track.clips.map((clip) => clipItem(clip, isAudio)).filter((s): s is string => Boolean(s));
    if (!items.length) return null;
    const lines = [`      <track>`];
    if (track.visible === false) lines.push(`        <enabled>FALSE</enabled>`);
    if (isAudio && track.volume !== undefined && Math.abs(track.volume - 1) > 0.001) {
      const level = Math.round(20 * Math.log10(Math.max(track.volume, 0.0001)) * 100) / 100;
      lines.push(`        <outputchannelindex>1</outputchannelindex>`);
      lines.push(`        <!-- track volume ${track.volume} (${level} dB) -->`);
    }
    lines.push(...items);
    lines.push(`      </track>`);
    return lines.join("\n");
  }

  // Build tracks before the header so warnings + file elements are complete.
  const videoTrackXml = videoTracks.map((t) => trackElement(t, false)).filter((s): s is string => Boolean(s));
  const audioTrackXml = audioTracks.map((t) => trackElement(t, true)).filter((s): s is string => Boolean(s));

  if (!videoTrackXml.length && !audioTrackXml.length) {
    warnings.push("Project has no exportable video or audio clips — the sequence will be empty.");
  }

  const sequenceId = `sequence-${project.id}`;
  // FCP7 itself wraps the sequence in <project><children>; both Premiere and
  // Filmora accept that shape, so emit the native structure rather than a
  // bare <sequence> root.
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="4">`,
    `  <project>`,
    `    <name>${escapeXml(project.name)}</name>`,
    `    <children>`,
    `  <sequence id="${escapeXml(sequenceId)}">`,
    `    <uuid>${escapeXml(project.id)}</uuid>`,
    `    <name>${escapeXml(project.name)}</name>`,
    `    <duration>${Math.max(1, durationFrames)}</duration>`,
    rateBlock(safeFps, "    "),
    `    <timecode>`,
    rateBlock(safeFps, "      "),
    `      <string>00:00:00:00</string>`,
    `      <frame>0</frame>`,
    `      <displayformat>NDF</displayformat>`,
    `    </timecode>`,
    `    <media>`,
    `      <video>`,
    `        <format>`,
    `          <samplecharacteristics>`,
    rateBlock(safeFps, "            "),
    `            <width>${project.width || 1920}</width>`,
    `            <height>${project.height || 1080}</height>`,
    `            <anamorphic>FALSE</anamorphic>`,
    `            <pixelaspectratio>square</pixelaspectratio>`,
    `            <fielddominance>none</fielddominance>`,
    `          </samplecharacteristics>`,
    `        </format>`,
    ...videoTrackXml,
    `      </video>`,
    ...(audioTrackXml.length
      ? [
          `      <audio>`,
          `        <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>`,
          ...audioTrackXml,
          `      </audio>`,
        ]
      : []),
    `    </media>`,
    `  </sequence>`,
    `    </children>`,
    `  </project>`,
    `</xmeml>`,
    ``,
  ].join("\n");

  return {
    xml,
    stats: {
      videoTracks: videoTrackXml.length,
      audioTracks: audioTrackXml.length,
      clipItems,
      files: fileSeq,
      durationFrames,
    },
    warnings,
  };
}
