/**
 * Text & captions tools.
 *
 *   - add_text             : add a text overlay with timeline window + content + style
 *   - update_text          : update text content / style on an existing overlay
 *   - delete_text          : remove a text overlay
 *   - set_text_style       : set font/color/size/bold/italic in one call
 *   - set_text_position    : set x/y position on canvas (px)
 *
 * These tools mutate the EditorProject.texts array. They also update the
 * underlying CapCut text-material reference (in the materials.texts bucket)
 * so the change persists when written back.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { executeWrite } from "../safety/dry-run.js";
import { bus } from "../notifications/events.js";
import { withRetry } from "../utils/fs.js";
import { uid } from "../utils/id.js";

const addTextSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  text: z.string().min(1).describe("Text content (use \\n for line breaks)."),
  start: z.number().int().min(0).describe("Start on the timeline, microseconds."),
  end: z.number().int().min(0).describe("End on the timeline, microseconds."),
  fontFamily: z.string().optional().describe("Font family/path. CapCut uses font_path; OpenCut uses fontFamily."),
  fontSize: z.number().int().positive().optional().describe("Font size in px."),
  color: z.string().optional().describe('Text color hex, e.g. "#FFFFFFFF".'),
  backgroundColor: z.string().optional().describe('Background color hex.'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  x: z.number().optional().describe("X position in canvas px."),
  y: z.number().optional().describe("Y position in canvas px."),
  dryRun: z.boolean().default(true).describe("When true, the in-memory cache is updated but NOT written to disk."),
});

const updateTextSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  textId: z.string().min(1).describe("Text overlay id."),
  text: z.string().optional().describe("New text content."),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().int().positive().optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  dryRun: z.boolean().default(true).describe("Same semantics as add_text."),
});

const deleteTextSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  textId: z.string().min(1).describe("Text overlay id."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_text."),
});

const setTextStyleSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  textId: z.string().min(1).describe("Text overlay id."),
  fontFamily: z.string().optional(),
  fontSize: z.number().int().positive().optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  dryRun: z.boolean().default(true).describe("Same semantics as add_text."),
});

const setTextPositionSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  textId: z.string().min(1).describe("Text overlay id."),
  x: z.number(),
  y: z.number(),
  dryRun: z.boolean().default(true).describe("Same semantics as add_text."),
});

function findText(projectId: string, textId: string) {
  const p = facade.getOpenProject(projectId);
  const t = p.texts.find((x) => x.id === textId);
  if (!t) throw new Error(`Text ${textId} not found in project ${projectId}.`);
  return { p, t };
}

async function applyTextMutation(
  projectId: string,
  description: string,
  dryRun: boolean,
  mutate: () => void | Promise<void>,
): Promise<ToolResult> {
  const project = facade.getOpenProject(projectId);
  await mutate();
  facade.cacheProject(project);
  if (dryRun) {
    return {
      ok: true,
      summary: `[DRY-RUN] ${description}. In-memory cache updated; NOT written to disk.`,
      data: { projectId, dryRun: true },
      dryRun: true,
    } satisfies ToolResult;
  }
  return await executeWrite({
    dryRun: false,
    targetPath: project.filePath,
    newValue: project,
    description,
    apply: async () => {
      await withRetry(() => facade.saveProject(project));
      bus.emitProjectChanged({
        projectId: project.id,
        kind: project.editor,
        change: "draft-written",
        filePath: project.filePath,
      });
    },
  });
}

export const textTools: Tool[] = [
  {
    name: "add_text",
    description: "Add a text overlay at a given timeline window with optional styling. The text appears on the canvas; persists on save_project.",
    inputSchema: addTextSchema,
    run: async (raw) => {
      const input = addTextSchema.parse(raw);
      return applyTextMutation(
        input.id,
        `Add text "${input.text.slice(0, 30)}${input.text.length > 30 ? "…" : ""}"`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const overlay = {
            id: uid("text_"),
            text: input.text,
            start: input.start,
            end: input.end,
            ...(input.fontFamily ? { fontFamily: input.fontFamily } : {}),
            ...(typeof input.fontSize === "number" ? { fontSize: input.fontSize } : {}),
            ...(input.color ? { color: input.color } : {}),
            ...(input.backgroundColor ? { backgroundColor: input.backgroundColor } : {}),
            ...(typeof input.bold === "boolean" ? { bold: input.bold } : {}),
            ...(typeof input.italic === "boolean" ? { italic: input.italic } : {}),
            ...(typeof input.x === "number" ? { x: input.x } : {}),
            ...(typeof input.y === "number" ? { y: input.y } : {}),
          };
          project.texts.push(overlay);
        },
      );
    },
  },
  {
    name: "update_text",
    description: "Update fields of an existing text overlay. Only supplied fields change.",
    inputSchema: updateTextSchema,
    run: async (raw) => {
      const input = updateTextSchema.parse(raw);
      return applyTextMutation(
        input.id,
        `Update text ${input.textId}`,
        input.dryRun,
        () => {
          const { t } = findText(input.id, input.textId);
          if (typeof input.text === "string") t.text = input.text;
          if (typeof input.start === "number") t.start = input.start;
          if (typeof input.end === "number") t.end = input.end;
          if (typeof input.fontFamily === "string") t.fontFamily = input.fontFamily;
          if (typeof input.fontSize === "number") t.fontSize = input.fontSize;
          if (typeof input.color === "string") t.color = input.color;
          if (typeof input.backgroundColor === "string") t.backgroundColor = input.backgroundColor;
          if (typeof input.bold === "boolean") t.bold = input.bold;
          if (typeof input.italic === "boolean") t.italic = input.italic;
          if (typeof input.x === "number") t.x = input.x;
          if (typeof input.y === "number") t.y = input.y;
        },
      );
    },
  },
  {
    name: "delete_text",
    description: "Remove a text overlay.",
    inputSchema: deleteTextSchema,
    run: async (raw) => {
      const input = deleteTextSchema.parse(raw);
      return applyTextMutation(
        input.id,
        `Delete text ${input.textId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          project.texts = project.texts.filter((t) => t.id !== input.textId);
        },
      );
    },
  },
  {
    name: "set_text_style",
    description: "Set font/color/size/bold/italic for a text overlay in one call.",
    inputSchema: setTextStyleSchema,
    run: async (raw) => {
      const input = setTextStyleSchema.parse(raw);
      return applyTextMutation(
        input.id,
        `Style text ${input.textId}`,
        input.dryRun,
        () => {
          const { t } = findText(input.id, input.textId);
          if (typeof input.fontFamily === "string") t.fontFamily = input.fontFamily;
          if (typeof input.fontSize === "number") t.fontSize = input.fontSize;
          if (typeof input.color === "string") t.color = input.color;
          if (typeof input.backgroundColor === "string") t.backgroundColor = input.backgroundColor;
          if (typeof input.bold === "boolean") t.bold = input.bold;
          if (typeof input.italic === "boolean") t.italic = input.italic;
        },
      );
    },
  },
  {
    name: "set_text_position",
    description: "Move a text overlay to a new x/y position on the canvas.",
    inputSchema: setTextPositionSchema,
    run: async (raw) => {
      const input = setTextPositionSchema.parse(raw);
      return applyTextMutation(
        input.id,
        `Move text ${input.textId} to (${input.x}, ${input.y})`,
        input.dryRun,
        () => {
          const { t } = findText(input.id, input.textId);
          t.x = input.x;
          t.y = input.y;
        },
      );
    },
  },
];
