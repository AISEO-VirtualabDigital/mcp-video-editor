/**
 * Render backends — spawn external open-source renderers as child processes.
 *
 * The MCP server itself does not own a rendering pipeline; it shells out to the
 * open-source backends so that AI-generated compositions can be turned into
 * MP4s:
 *   - "remotion"     -> `npx remotion render <composition> <output>`
 *   - "hyperframes"  -> `npx hyperframes render` (operates on an `index.html`
 *                       composition in the working directory)
 *
 * Both renderers are deterministic (headless Chrome frame capture + FFmpeg
 * encode), which makes them suitable for AI-agent-driven rendering pipelines.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export type RenderEngineKind = "remotion" | "hyperframes" | "motion";

export interface RenderJob {
  engine: RenderEngineKind;
  /** Human-readable project name (used as the Remotion composition fallback). */
  projectName: string;
  /** Remotion entry file, e.g. "src/index.ts". */
  entry?: string;
  /** Remotion composition id; defaults to the project name. */
  compositionId?: string;
  /** Output MP4 path. */
  outputPath: string;
  /** Working directory for the renderer process. */
  cwd?: string;
}

export interface RenderJobResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Default render timeout (30 minutes) — long enough for real renders, bounded. */
const RENDER_TIMEOUT_MS = 30 * 60 * 1000;

/** Build the CLI args for the Remotion renderer. */
export function buildRemotionArgs(job: RenderJob): string[] {
  const entry = job.entry ?? "src/index.ts";
  const compositionId = job.compositionId ?? job.projectName;
  const entryPath = path.resolve(process.cwd(), entry);
  const cwd = path.dirname(entryPath);
  return ["render", compositionId, job.outputPath];
}

/** Build the CLI args for the HyperFrames renderer. */
export function buildHyperframesArgs(): string[] {
  return ["render"];
}

/**
 * Start a render job. Returns a promise that resolves when the renderer exits
 * and the spawned process handle (for cancellation via timeout).
 */
export function startRenderJob(job: RenderJob): { promise: Promise<RenderJobResult>; proc: ChildProcess } {
  const backendEngine: RenderEngineKind = job.engine === "motion" ? "remotion" : job.engine;
  const args = backendEngine === "remotion" ? buildRemotionArgs(job) : buildHyperframesArgs();
  const cwd = job.engine === "remotion" ? job.cwd ?? path.dirname(path.resolve(process.cwd(), job.entry ?? "src/index.ts")) : job.cwd ?? process.cwd();
  const proc = spawn("npx", args, { shell: true, stdio: ["ignore", "pipe", "pipe"], cwd });

  const promise = new Promise<RenderJobResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve({ code: null, stdout, stderr: `${stderr}\n[render] timed out after ${RENDER_TIMEOUT_MS / 1000}s` });
      }
    }, RENDER_TIMEOUT_MS);
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}` });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

  return { promise, proc };
}
