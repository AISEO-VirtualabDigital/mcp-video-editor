/**
 * TTS backends — synthesize speech audio from text.
 *
 * Providers:
 *   - "openai":     OpenAI TTS API (https://api.openai.com/v1/audio/speech) — requires OPENAI_API_KEY.
 *   - "elevenlabs": ElevenLabs TTS API (https://api.elevenlabs.io/v1/text-to-speech/{voiceId}) — requires ELEVENLABS_API_KEY.
 *
 * The outputs are MP3 audio files written to a caller-provided absolute path.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type TtsProvider = "openai" | "elevenlabs";

export interface TtsJob {
  provider: TtsProvider;
  text: string;
  voice?: string;
  model?: string;
  outputPath: string;
}

export interface TtsResult {
  ok: boolean;
  bytesWritten?: number;
  error?: string;
}

export async function synthesizeSpeech(job: TtsJob): Promise<TtsResult> {
  const { provider, text, outputPath } = job;
  const writeFile = async (buf: ArrayBuffer): Promise<number> => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const bytes = Buffer.from(buf);
    await fs.writeFile(outputPath, bytes);
    return bytes.length;
  };

  try {
    if (provider === "openai") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return { ok: false, error: "OPENAI_API_KEY is not set. Configure it to use the OpenAI TTS provider." };
      }
      const model = job.model ?? "tts-1";
      const voice = job.voice ?? "alloy";
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return { ok: false, error: `OpenAI TTS failed (${res.status}): ${detail.slice(0, 500)}` };
      }
      const buf = await res.arrayBuffer();
      const bytesWritten = await writeFile(buf);
      return { ok: true, bytesWritten };
    }

    if (provider === "elevenlabs") {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        return { ok: false, error: "ELEVENLABS_API_KEY is not set. Configure it to use the ElevenLabs TTS provider." };
      }
      const voiceId = job.voice ?? "21m00Tcm4TlvDq8ikWAM";
      const modelId = job.model ?? "eleven_multilingual_v2";
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return { ok: false, error: `ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 500)}` };
      }
      const buf = await res.arrayBuffer();
      const bytesWritten = await writeFile(buf);
      return { ok: true, bytesWritten };
    }

    return { ok: false, error: `Unsupported TTS provider: ${provider}` };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.message };
  }
}
