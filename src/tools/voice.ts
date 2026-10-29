/**
 * Voice generation tools — synthesize speech audio from text via TTS providers.
 *
 *   - generate_voice  : synthesize an MP3 voiceover from text and write it under the export root
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import { synthesizeSpeech, type TtsProvider } from "../tts/backends.js";
import { exportRoot } from "../utils/paths.js";
import { assertPathInside } from "../safety/path-guard.js";
import path from "node:path";

const generateVoiceSchema = z.object({
  text: z.string().min(1).describe("Script text to synthesize. Use \\n for multi-line narration."),
  provider: z.enum(["openai", "elevenlabs"]).default("openai").describe("TTS provider to use."),
  voice: z.string().optional().describe("Voice name (OpenAI: alloy|echo|...; ElevenLabs: voiceId)."),
  model: z.string().optional().describe("TTS model override (OpenAI: tts-1|tts-1-hd; ElevenLabs: eleven_multilingual_v2|...)."),
  outputPath: z.string().optional().describe("Output audio path. Defaults to <exportRoot>/<slug>.mp3."),
  dryRun: z.boolean().default(true).describe("When true, no synthesis is performed (dry-run default)."),
});

export const voiceTools: Tool[] = [
  {
    name: "generate_voice",
    description: "Synthesize speech audio from text using a TTS provider (OpenAI or ElevenLabs). Writes an MP3 under the export root. Honors dry-run by default.",
    inputSchema: generateVoiceSchema,
    run: async (raw) => {
      const input = generateVoiceSchema.parse(raw);
      const slug = input.text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "voice";
      const outPath = input.outputPath ? path.resolve(input.outputPath) : path.resolve(path.join(exportRoot(), `${slug}.mp3`));
      try {
        assertPathInside(outPath, exportRoot(), "outputPath");
      } catch (err) {
        return { ok: false, summary: `Unsafe output path: ${(err as Error).message}`, error: "unsafe-path" } satisfies ToolResult;
      }

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] Would synthesize ${input.provider} TTS for text "${input.text.slice(0, 30)}..." to ${outPath}. No audio written.`,
          data: { provider: input.provider, voice: input.voice, model: input.model, outputPath: outPath, dryRun: true },
          dryRun: true,
        } satisfies ToolResult;
      }

      const result = await synthesizeSpeech({ provider: input.provider, text: input.text, voice: input.voice, model: input.model, outputPath: outPath });
      if (!result.ok) {
        return { ok: false, summary: `TTS synthesis failed: ${result.error}`, error: "tts-failed", data: { provider: input.provider, outputPath: outPath } } satisfies ToolResult;
      }

      return {
        ok: true,
        summary: `Generated ${input.provider} TTS audio (${result.bytesWritten ?? 0} bytes) -> ${outPath}`,
        data: { provider: input.provider, voice: input.voice, model: input.model, outputPath: outPath, bytesWritten: result.bytesWritten, dryRun: false },
        dryRun: false,
      } satisfies ToolResult;
    },
  },
];
