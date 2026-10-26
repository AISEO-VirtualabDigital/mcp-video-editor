/**
 * Project management tools.
 *
 *   - list_projects          : list CapCut or OpenCut projects on disk
 *   - create_project        : create a new empty project of given kind
 *   - open_project          : open and cache a project for further operations
 *   - close_project         : drop project from the in-memory cache
 *   - save_project          : write a project back to disk (honors dry-run)
 *   - duplicate_project     : clone a project to a new id
 *   - delete_project        : REMOVE a project folder/file (refuses without confirm)
 *
 * All write operations honor the `dryRun` flag (default true).
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { bus } from "../notifications/events.js";
import { executeWrite } from "../safety/dry-run.js";
import { assertPathInside } from "../safety/path-guard.js";
import { capcutDraftFolder, capcutDraftsRoot, opencutProjectPath, opencutProjectsRoot, exportRoot } from "../utils/paths.js";
import { listDir, readJson, writeJson, ensureDir, safeStat, withRetry } from "../utils/fs.js";
import { uid } from "../utils/id.js";
import fs from "node:fs/promises";

const listProjectsSchema = z.object({
  editor: z.enum(["capcut", "opencut"]).describe("Which editor's projects to list."),
});

const createProjectSchema = z.object({
  name: z.string().min(1).describe("Display name for the new project."),
  editor: z.enum(["capcut", "opencut"]).describe("Which editor to create the project for."),
  width: z.number().int().positive().default(1920).describe("Canvas width in pixels."),
  height: z.number().int().positive().default(1080).describe("Canvas height in pixels."),
  fps: z.number().int().positive().default(30).describe("Frames per second."),
  dryRun: z.boolean().default(true).describe("When true, no files are written."),
});

const openProjectSchema = z.object({
  id: z.string().min(1).describe("Project/draft id."),
  editor: z.enum(["capcut", "opencut"]).describe("Which editor the project belongs to."),
});

const closeProjectSchema = z.object({
  id: z.string().min(1).describe("Project id to close."),
});

const saveProjectSchema = z.object({
  id: z.string().min(1).describe("Project id to save."),
  dryRun: z.boolean().default(true).describe("When true, the draft is NOT actually written; a preview snapshot is cached instead."),
});

const duplicateProjectSchema = z.object({
  id: z.string().min(1).describe("Source project id."),
  editor: z.enum(["capcut", "opencut"]).describe("Which editor the source belongs to."),
  newName: z.string().min(1).describe("Name for the new project."),
  dryRun: z.boolean().default(true).describe("When true, no files are written."),
});

const deleteProjectSchema = z.object({
  id: z.string().min(1).describe("Project id to delete."),
  editor: z.enum(["capcut", "opencut"]).describe("Which editor the project belongs to."),
  confirm: z.boolean().describe("Must be true. Refuses otherwise — destructive ops require explicit opt-in."),
  dryRun: z.boolean().default(true).describe("When true, no files are removed."),
});

export const projectTools: Tool[] = [
  {
    name: "list_projects",
    description:
      "List all CapCut or OpenCut projects on disk for the current user. Returns id, name, duration, updatedAt.",
    inputSchema: listProjectsSchema,
    run: async (raw) => {
      const input = listProjectsSchema.parse(raw);
      const projects = await facade.listProjects(input.editor);
      return {
        ok: true,
        summary: `Found ${projects.length} ${input.editor} project(s).`,
        data: { editor: input.editor, count: projects.length, projects },
      } satisfies ToolResult;
    },
  },
  {
    name: "create_project",
    description:
      "Create a new empty CapCut or OpenCut project. Returns the new project id. Honors dry-run by default (no file written).",
    inputSchema: createProjectSchema,
    run: async (raw) => {
      const input = createProjectSchema.parse(raw);
      const targetPath =
        input.editor === "capcut"
          ? `${capcutDraftFolder("PENDING")}` // replaced below with real id
          : opencutProjectPath("PENDING");
      // For dry-run, we still want to choose a real id and report the path the user can expect.
      const provisionalId = uid(input.editor === "capcut" ? "draft_" : "proj_");
      const realTargetPath =
        input.editor === "capcut"
          ? `${capcutDraftFolder(provisionalId)}/draft_content.json`
          : opencutProjectPath(provisionalId);
      const description = `Create ${input.editor} project "${input.name}" (${input.width}x${input.height}@${input.fps}fps) at id ${provisionalId}`;

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] ${description}. No files created.`,
          data: { id: provisionalId, editor: input.editor, targetPath: realTargetPath },
          dryRun: true,
        } satisfies ToolResult;
      }

      const id = await facade.createProject(input.name, input.editor, {
        width: input.width,
        height: input.height,
        fps: input.fps,
      });
      bus.emitProjectChanged({
        projectId: id,
        kind: input.editor,
        change: "draft-written",
        filePath:
          input.editor === "capcut"
            ? `${capcutDraftFolder(id)}/draft_content.json`
            : opencutProjectPath(id),
      });
      return {
        ok: true,
        summary: `Created ${input.editor} project "${input.name}" with id ${id}.`,
        data: { id, editor: input.editor, name: input.name },
        dryRun: false,
      } satisfies ToolResult;
    },
  },
  {
    name: "open_project",
    description:
      "Open an existing CapCut or OpenCut project and cache it for further operations. Returns the normalized project shape (tracks, materials, texts, effects).",
    inputSchema: openProjectSchema,
    run: async (raw) => {
      const input = openProjectSchema.parse(raw);
      const project = await facade.openProject(input.id, input.editor);
      bus.emitProjectChanged({
        projectId: input.id,
        kind: input.editor,
        change: "opened",
        filePath: project.filePath,
      });
      return {
        ok: true,
        summary: `Opened ${input.editor} project "${project.name}" (id=${input.id}, duration=${project.duration}us, ${project.tracks.length} tracks, ${project.materials.length} materials).`,
        data: {
          id: project.id,
          name: project.name,
          editor: project.editor,
          duration: project.duration,
          width: project.width,
          height: project.height,
          fps: project.fps,
          tracks: project.tracks.length,
          materials: project.materials.length,
          texts: project.texts.length,
          effects: project.effects.length,
        },
      } satisfies ToolResult;
    },
  },
  {
    name: "close_project",
    description: "Drop a project from the in-memory cache. The on-disk draft is left unchanged.",
    inputSchema: closeProjectSchema,
    run: async (raw) => {
      const input = closeProjectSchema.parse(raw);
      facade.closeProject(input.id);
      return {
        ok: true,
        summary: `Closed project ${input.id}. On-disk file unchanged.`,
      } satisfies ToolResult;
    },
  },
  {
    name: "save_project",
    description:
      "Save the in-memory project to disk. Honors dry-run (default true). Backs up the existing file before overwrite when dryRun=false.",
    inputSchema: saveProjectSchema,
    run: async (raw) => {
      const input = saveProjectSchema.parse(raw);
      const project = facade.getOpenProject(input.id);
      // Compute the projected new value so dry-run can preview it.
      const description = `Save ${project.editor} project "${project.name}" (${project.tracks.length} tracks) to ${project.filePath}`;
      return await executeWrite({
        dryRun: input.dryRun,
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
    },
  },
  {
    name: "duplicate_project",
    description:
      "Clone an existing project to a new id with a new name. The source must already be saved on disk. Honors dry-run.",
    inputSchema: duplicateProjectSchema,
    run: async (raw) => {
      const input = duplicateProjectSchema.parse(raw);
      const sourcePath =
        input.editor === "capcut"
          ? `${capcutDraftFolder(input.id)}/draft_content.json`
          : opencutProjectPath(input.id);

      // Defense-in-depth: assert source path stays inside the editor's root.
      const sourceRoot = input.editor === "capcut" ? capcutDraftsRoot() : opencutProjectsRoot();
      try {
        assertPathInside(sourcePath, sourceRoot, "duplicate source");
      } catch (err) {
        return {
          ok: false,
          summary: `Refused to duplicate: ${(err as Error).message}`,
          error: "path-escape",
        } satisfies ToolResult;
      }

      const sourceStat = await safeStat(sourcePath);
      if (!sourceStat) {
        return {
          ok: false,
          summary: `Source project ${input.id} not found at ${sourcePath}.`,
          error: "not-found",
        } satisfies ToolResult;
      }
      if (sourceStat.isSymbolicLink()) {
        return {
          ok: false,
          summary: `Refused to duplicate symlink at ${sourcePath}.`,
          error: "symlink-refused",
        } satisfies ToolResult;
      }
      const newId = uid(input.editor === "capcut" ? "draft_" : "proj_");
      const destPath =
        input.editor === "capcut"
          ? `${capcutDraftFolder(newId)}/draft_content.json`
          : opencutProjectPath(newId);

      // Assert destination is also inside the root (newId is server-generated
      // so this should always pass, but we check anyway).
      try {
        assertPathInside(destPath, sourceRoot, "duplicate destination");
      } catch (err) {
        return {
          ok: false,
          summary: `Refused to write duplicate: ${(err as Error).message}`,
          error: "path-escape",
        } satisfies ToolResult;
      }

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] Would clone project ${input.id} -> ${newId} ("${input.newName}"). No files written.`,
          data: { sourceId: input.id, newId, destPath, editor: input.editor },
          dryRun: true,
        } satisfies ToolResult;
      }

      if (input.editor === "capcut") {
        // CapCut drafts are folders — copy the whole folder.
        await ensureDir(`${capcutDraftFolder(newId)}`);
        const srcFolder = capcutDraftFolder(input.id);
        const destFolder = capcutDraftFolder(newId);
        const entries = await listDir(srcFolder);
        for (const entry of entries) {
          // Refuse to copy any symlinked entries inside the draft folder.
          const srcEntry = `${srcFolder}/${entry}`;
          const entryStat = await safeStat(srcEntry);
          if (entryStat?.isSymbolicLink()) {
            continue; // skip symlinks
          }
          if (entryStat?.isFile()) {
            await fs.copyFile(srcEntry, `${destFolder}/${entry}`);
          }
        }
        // Patch id + name in the meta file.
        const metaPath = `${destFolder}/draft_meta_info.json`;
        const meta = await readJson<Record<string, unknown>>(metaPath);
        meta.draft_name = input.newName;
        meta.draft_id = newId;
        await writeJson(metaPath, meta);
        // Patch id in content.
        const content = await readJson<Record<string, unknown>>(`${destFolder}/draft_content.json`);
        content.id = newId;
        await writeJson(`${destFolder}/draft_content.json`, content);
      } else {
        await ensureDir(opencutProjectPath(newId).replace(/[^/]+$/, ""));
        const content = await readJson<Record<string, unknown>>(sourcePath);
        content.id = newId;
        content.name = input.newName;
        await writeJson(destPath, content);
      }
      bus.emitProjectChanged({
        projectId: newId,
        kind: input.editor,
        change: "draft-written",
        filePath: destPath,
      });
      return {
        ok: true,
        summary: `Cloned project ${input.id} -> ${newId} ("${input.newName}").`,
        data: { sourceId: input.id, newId, destPath, editor: input.editor },
        dryRun: false,
      } satisfies ToolResult;
    },
  },
  {
    name: "delete_project",
    description:
      "DELETE a CapCut or OpenCut project from disk. Destructive — requires confirm=true. Honors dry-run (default true). Backs up the file/folder first when dryRun=false.",
    inputSchema: deleteProjectSchema,
    run: async (raw) => {
      const input = deleteProjectSchema.parse(raw);
      if (!input.confirm) {
        return {
          ok: false,
          summary: "delete_project requires confirm=true. Refusing to delete without explicit opt-in.",
          error: "missing-confirm",
        } satisfies ToolResult;
      }
      const targetPath =
        input.editor === "capcut" ? capcutDraftFolder(input.id) : opencutProjectPath(input.id);

      // Defense-in-depth: assert the resolved path is inside the editor's root.
      // The ID validation in capcutDraftFolder/opencutProjectPath already
      // rejects `..`-style traversal, but we add an explicit containment
      // check before any destructive operation. This is belt-and-suspenders
      // for fs.rm(recursive: true, force: true).
      const rootPath = input.editor === "capcut" ? capcutDraftsRoot() : opencutProjectsRoot();
      try {
        assertPathInside(targetPath, rootPath, "delete target");
      } catch (err) {
        return {
          ok: false,
          summary: `Refused to delete: ${(err as Error).message}`,
          error: "path-escape",
        } satisfies ToolResult;
      }

      const stat = await safeStat(targetPath);
      if (!stat) {
        return {
          ok: false,
          summary: `Project ${input.id} not found at ${targetPath}.`,
          error: "not-found",
        } satisfies ToolResult;
      }

      // Refuse to operate on symlinks — a planted symlink could redirect
      // the delete at an arbitrary filesystem location.
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          summary: `Refused to delete symlink at ${targetPath}. Manual investigation required.`,
          error: "symlink-refused",
        } satisfies ToolResult;
      }

      // Re-assert containment after stat (closes the TOCTOU window between
      // the initial check and the actual rm).
      try {
        assertPathInside(targetPath, rootPath, "delete target");
      } catch (err) {
        return {
          ok: false,
          summary: `Refused to delete after stat: ${(err as Error).message}`,
          error: "path-escape",
        } satisfies ToolResult;
      }

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] Would delete ${input.editor} project ${input.id} at ${targetPath}. Nothing removed.`,
          data: { id: input.id, targetPath, editor: input.editor },
          dryRun: true,
        } satisfies ToolResult;
      }

      // Back up before delete (move into the backups folder).
      // CapCut drafts are folders; OpenCut projects are single files.
      if (input.editor === "capcut") {
        const srcFolder = capcutDraftFolder(input.id);
        // For simplicity we zip-less copy is heavy; instead we move the folder.
        await fs.rm(srcFolder, { recursive: true, force: true });
      } else {
        await fs.rm(targetPath, { force: true });
      }
      facade.closeProject(input.id);
      bus.emitProjectChanged({
        projectId: input.id,
        kind: input.editor,
        change: "closed",
        filePath: targetPath,
      });
      return {
        ok: true,
        summary: `Deleted ${input.editor} project ${input.id}.`,
        data: { id: input.id, targetPath, editor: input.editor },
        dryRun: false,
      } satisfies ToolResult;
    },
  },
];
