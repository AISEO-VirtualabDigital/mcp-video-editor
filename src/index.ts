#!/usr/bin/env node
/**
 * mcp-video-editor entry point.
 *
 * Run with: `node dist/index.js`  (or `npm start`, or `npx mcp-video-editor`)
 *
 * The server speaks JSON-RPC 2.0 over stdio per the Model Context Protocol
 * spec. Any MCP-compatible client (Cursor, Claude Desktop, Codex,
 * Antigravity, OpenCode, KiloCode) can launch and connect to it.
 */

import { startServer } from "./server.js";

// Catch-all error handlers — a crash here takes down the AI client's tool
// connection, so we log to stderr (NEVER stdout, which is the protocol channel).
process.on("uncaughtException", (err) => {
  console.error(`[mcp-video-editor] uncaughtException: ${err.stack ?? err}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[mcp-video-editor] unhandledRejection: ${reason}`);
});

// Ignore SIGPIPE — some clients close stdout abruptly on disconnect.
process.on("SIGPIPE", () => {
  // no-op
});

startServer().catch((err) => {
  console.error(`[mcp-video-editor] failed to start: ${err.stack ?? err}`);
  process.exit(1);
});
