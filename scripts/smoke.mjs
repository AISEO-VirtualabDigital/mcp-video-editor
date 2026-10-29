#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Spawns the built server over stdio with every path redirected into a
 * throwaway sandbox, then drives the real tool surface: create → open → track →
 * clip → export → unsafe-path refusal, plus an OpenCut vendor-field round-trip
 * check and a temp-file-litter check.
 *
 * Run with `npm run smoke` (builds first). Exits non-zero on the first failure.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdk = path.join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
const { Client } = await import(path.join(sdk, "client", "index.js"));
const { StdioClientTransport } = await import(path.join(sdk, "client", "stdio.js"));

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-video-smoke-"));
const dirs = {
  opencut: path.join(sandbox, "opencut"),
  backups: path.join(sandbox, "backups"),
  export: path.join(sandbox, "export"),
  cache: path.join(sandbox, "cache"),
  home: path.join(sandbox, "home"),
  media: path.join(sandbox, "media"),
};
for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });
const sourceVideo = path.join(dirs.media, "clip.mp4");
const sourceAudio = path.join(dirs.media, "voice.mp3");
await fs.writeFile(sourceVideo, "not a real mp4 — the server only stats it");
await fs.writeFile(sourceAudio, "not a real mp3");

const EXPECTED_TOOLS = 59;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${String(err.message).split("\n")[0]}`);
    process.exitCode = 1;
    throw err;
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "dist", "index.js")],
  env: {
    ...process.env,
    HOME: dirs.home,
    MCP_VIDEO_BACKUP_DIR: dirs.backups,
    MCP_VIDEO_EXPORT_DIR: dirs.export,
    MCP_VIDEO_CACHE_DIR: dirs.cache,
    OPENCUT_PROJECTS_DIR: dirs.opencut,
  },
});
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

/** First text block of a tool result. */
const text = (result) => (result.content ?? []).map((b) => b.text ?? "").join("\n");

/** Call a tool and require it to succeed. */
async function must(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const body = text(result);
  assert.ok(!result.isError, `${name} failed: ${body.split("\n")[0]}`);
  return body;
}

/**
 * Call a tool and parse the JSON block it returns.
 *
 * Tool results are `[OK] <name>` on the first line followed by the JSON body, so
 * slice from the first brace instead of assuming the whole block parses.
 */
async function mustJson(name, args) {
  const body = await must(name, args);
  const start = body.search(/\n[[{]/) + 1;
  assert.ok(start > 0, `${name} returned no JSON: ${body.slice(0, 120)}`);
  return JSON.parse(body.slice(start));
}

/** Call a tool and require it to refuse with `error`. */
async function mustRefuse(name, args, error) {
  const result = await client.callTool({ name, arguments: args });
  const body = text(result);
  assert.ok(result.isError || /\[FAIL\]/.test(body), `${name} unexpectedly succeeded`);
  assert.match(body, new RegExp(error, "i"), `${name} refused for the wrong reason: ${body.split("\n")[0]}`);
}

try {
  const { tools } = await client.listTools();
  await check(`tool count is ${EXPECTED_TOOLS}`, () => assert.equal(tools.length, EXPECTED_TOOLS));
  for (const name of ["create_project", "open_project", "add_track", "add_video_clip", "export_timeline_xml", "get_timeline"]) {
    await check(`tool "${name}" is registered`, () => assert.ok(tools.some((t) => t.name === name)));
  }
  await check("every tool has a description", () =>
    assert.ok(tools.every((t) => typeof t.description === "string" && t.description.length > 20)));

  // --- create → open → track → clip ---------------------------------------
  const created = await must("create_project", {
    name: "Smoke Test",
    editor: "opencut",
    durationInSeconds: 6,
    dryRun: false,
  });
  const id = /(proj_[A-Za-z0-9_-]{10,})/.exec(created)?.[1];
  assert.ok(id, `no project id in create_project output: ${created}`);
  await check("create_project writes <id>.json (no suffixed temp name)", () =>
    fs.access(path.join(dirs.opencut, `${id}.json`)));

  const opened = await must("open_project", { id, editor: "opencut" });
  await check("open_project reports the project", () => assert.match(opened, /Opened opencut project/));

  await must("add_track", { id, kind: "video", dryRun: false });
  await must("add_track", { id, kind: "audio", dryRun: false });
  const timeline = await mustJson("get_timeline", { id });
  const videoTrack = timeline.tracks.find((t) => t.kind === "video")?.id;
  const audioTrack = timeline.tracks.find((t) => t.kind === "audio")?.id;
  await check("two tracks exist after add_track", () => assert.ok(videoTrack && audioTrack));

  await must("add_video_clip", {
    id,
    trackId: videoTrack,
    sourcePath: sourceVideo,
    duration: 6_000_000,
    width: 1080,
    height: 1920,
    dryRun: false,
  });
  await must("add_audio_clip", {
    id,
    trackId: audioTrack,
    sourcePath: sourceAudio,
    duration: 4_000_000,
    dryRun: false,
  });
  const afterClips = await mustJson("get_timeline", { id });
  await check("project duration follows the last clip end", () => assert.equal(afterClips.duration, 6_000_000));

  // --- dry-run must not write ---------------------------------------------
  const statBefore = (await fs.stat(path.join(dirs.opencut, `${id}.json`))).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const dry = await must("add_track", { id, kind: "video", dryRun: true });
  await check("dry-run says no file was written", () => assert.match(dry, /\[DRY-RUN\]/));
  await check("dry-run leaves the file untouched", async () =>
    assert.equal((await fs.stat(path.join(dirs.opencut, `${id}.json`))).mtimeMs, statBefore));

  // --- export -------------------------------------------------------------
  const dryXml = await must("export_timeline_xml", { id, target: "premiere", dryRun: true });
  await check("export dry-run is labelled BETA", () => assert.match(dryXml, /BETA/));
  const xmlPath = path.join(dirs.export, "smoke-test.xml");
  await must("export_timeline_xml", { id, target: "premiere", outputPath: xmlPath, dryRun: false });
  const xml = await fs.readFile(xmlPath, "utf-8");
  await check("exported XML is xmeml v4", () => assert.match(xml, /<xmeml version="4">/));
  await check("exported XML carries both clipitems", () => assert.equal((xml.match(/<clipitem/g) ?? []).length, 2));

  // --- path-traversal guard ----------------------------------------------
  await check("export refuses a path outside the export root", () =>
    mustRefuse("export_timeline_xml", { id, target: "premiere", outputPath: "/etc/evil.xml", dryRun: false }, "unsafe|escape"));
  await check("open refuses a traversal project id", () =>
    mustRefuse("open_project", { id: "../../etc/passwd", editor: "opencut" }, "invalid|unsafe|traversal"));

  // --- vendor round-trip --------------------------------------------------
  const seededId = "proj_roundtrip";
  const seeded = {
    version: "0.5",
    id: seededId,
    name: "Round Trip",
    duration: 0,
    width: 1920,
    height: 1080,
    fps: 30,
    vendorRootKey: { keep: "me" },
    tracks: [
      {
        id: "trk_keep",
        kind: "video",
        vendorTrackKey: 42,
        clips: [{
          id: "clip_keep",
          materialId: "mat_keep",
          sourceIn: 0,
          sourceOut: 1_000_000,
          targetStart: 0,
          targetEnd: 1_000_000,
          vendorClipKey: "abc",
        }],
      },
    ],
    materials: [{
      id: "mat_keep",
      type: "video",
      name: "keep.mp4",
      sourcePath: sourceVideo,
      duration: 1_000_000,
      width: 1920,
      height: 1080,
      vendorMatKey: [1, 2],
    }],
    texts: [],
    effects: [],
  };
  await fs.writeFile(path.join(dirs.opencut, `${seededId}.json`), JSON.stringify(seeded));
  await must("open_project", { id: seededId, editor: "opencut" });
  await must("add_track", { id: seededId, kind: "audio", dryRun: false });
  const round = JSON.parse(await fs.readFile(path.join(dirs.opencut, `${seededId}.json`), "utf-8"));
  await check("unknown root keys survive a write", () => assert.deepEqual(round.vendorRootKey, { keep: "me" }));
  await check("unknown track keys survive a write", () => assert.equal(round.tracks[0].vendorTrackKey, 42));
  await check("unknown clip keys survive a write", () => assert.equal(round.tracks[0].clips[0].vendorClipKey, "abc"));
  await check("unknown material keys survive a write", () => assert.deepEqual(round.materials[0].vendorMatKey, [1, 2]));
  await check("the new track is actually persisted", () => assert.equal(round.tracks.length, 2));

  const litter = (await fs.readdir(dirs.opencut)).filter((f) => f.endsWith(".tmp"));
  await check("no temp files left behind", () => assert.deepEqual(litter, []));

  console.log(`\n${passed} checks passed.`);
} finally {
  await client.close();
  await fs.rm(sandbox, { recursive: true, force: true });
}
