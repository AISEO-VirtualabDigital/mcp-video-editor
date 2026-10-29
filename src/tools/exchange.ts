/**
 * Timeline exchange tools — bridge CapCut/OpenCut projects into editors whose
 * project files we cannot write: Adobe Premiere and Wondershare Filmora.
 *
 * Both import FCP7 XML (xmeml), so one exporter serves both.
 */

import { z } from "zod";
import path from "node:path";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { buildXmeml } from "../export/xmeml.js";
import { exportRoot } from "../utils/paths.js";
import { writeText } from "../utils/fs.js";
import { assertPathInside } from "../safety/path-guard.js";
import { executeWrite } from "../safety/dry-run.js";

const exportTimelineXmlSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  target: z
    .enum(["premiere", "filmora", "generic"])
    .default("generic")
    .describe('Which editor will import the XML. "premiere" and "filmora" are the same xmeml v4 format — the value only changes the import instructions in the summary.'),
  fps: z.number().int().positive().optional().describe("Sequence frame rate override. Defaults to the project fps."),
  outputPath: z.string().optional().describe("Output .xml path. Defaults to <exportRoot>/<slug>.xml."),
  dryRun: z.boolean().default(true).describe("When true, build the XML and report stats without writing a file."),
});

const IMPORT_HINT: Record<"premiere" | "filmora" | "generic", string> = {
  premiere: "Import in Premiere: File > Import, select the .xml, the sequence lands in the bin.",
  filmora: 'Import in Filmora: Import > choose the file type "Timeline Exchange Format XML", then relink media if prompted.',
  generic: "Import via File > Import (Premiere) or Timeline Exchange Format XML (Filmora).",
};

export const exchangeTools: Tool[] = [
  {
    name: "export_timeline_xml",
    description:
      "Export the open project as FCP7 XML (xmeml v4) for import into Adobe Premiere or Wondershare Filmora — the format both editors document support for. Video and audio clips, media paths and volume levels survive; text overlays, stickers, effects and transitions do not (reported as warnings).",
    inputSchema: exportTimelineXmlSchema,
    run: async (raw) => {
      const input = exportTimelineXmlSchema.parse(raw);
      const project = facade.getOpenProject(input.id);
      const fps = input.fps ?? project.fps ?? 30;
      const { xml, stats, warnings } = buildXmeml(project, fps);

      const slug =
        project.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "timeline";
      const outPath = input.outputPath
        ? path.resolve(input.outputPath)
        : path.resolve(path.join(exportRoot(), `${slug}.xml`));

      try {
        assertPathInside(outPath, exportRoot(), "outputPath");
      } catch (err) {
        return {
          ok: false,
          summary: `Unsafe output path: ${(err as Error).message}`,
          error: "unsafe-path",
        } satisfies ToolResult;
      }

      const bytes = Buffer.byteLength(xml, "utf-8");
      const warnText = warnings.length ? ` Warnings: ${warnings.join(" ")}` : "";
      const description = `Export ${input.target} XML (${stats.videoTracks} video + ${stats.audioTracks} audio track(s), ${stats.clipItems} clip(s)) to ${outPath}`;

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] ${description} — ${bytes} bytes, ${stats.durationFrames} frames. ${IMPORT_HINT[input.target]}${warnText}`,
          data: { projectId: project.id, target: input.target, outputPath: outPath, bytes, stats, warnings },
          dryRun: true,
        } satisfies ToolResult;
      }

      const result = await executeWrite({
        dryRun: false,
        targetPath: outPath,
        newValue: { bytes, stats },
        description,
        apply: async () => {
          await writeText(outPath, xml);
        },
      });

      return {
        ...result,
        summary: `${result.summary} ${IMPORT_HINT[input.target]}${warnText}`,
        data: { projectId: project.id, target: input.target, outputPath: outPath, bytes, stats, warnings },
      } satisfies ToolResult;
    },
  },
];
