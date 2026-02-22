#!/usr/bin/env node
/**
 * civilclaw web server: HTTP + SSE backend for the React chat UI.
 *
 * Reuses the same agent session infrastructure as the CLI.
 */
import {
  loadDotEnv,
  ensureDirs,
  ensureApiKeyInEnv,
  resolveModelAndAuth,
  resolveSessionFile,
  applySystemPromptToSession,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  AGENT_DIR,
  ENV_KEY_MAP,
} from "./shared.js";

// Load env before any other imports that might need keys
loadDotEnv();

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { streamSimple } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  buildSystemPrompt,
  detectRuntime,
  loadContextFiles,
} from "./system-prompt.js";
import { createAllToolDefinitions } from "./tools/index.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);

// ─── Static file serving ────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// Resolve web/dist relative to this file's directory
let STATIC_DIR: string;
try {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  STATIC_DIR = path.resolve(__dirname, "../web/dist");
} catch {
  STATIC_DIR = path.resolve(process.cwd(), "web/dist");
}

function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  let filePath = path.join(STATIC_DIR, pathname);

  // Security: prevent path traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    return false;
  }

  // If directory, try index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    return false;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
  return true;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

ensureDirs();

const provider = DEFAULT_PROVIDER;
const modelId = DEFAULT_MODEL;
const workspaceDir = process.cwd();

const hasKey = ensureApiKeyInEnv(provider);
if (!hasKey) {
  const envKey = ENV_KEY_MAP[provider]?.[0] ?? `${provider.toUpperCase()}_API_KEY`;
  console.error(`No API key found for ${provider}. Set ${envKey}.`);
  process.exit(1);
}

const { model, authStorage, modelRegistry } = resolveModelAndAuth(provider, modelId);

const runtime = detectRuntime(provider, modelId);
const contextFiles = loadContextFiles(workspaceDir);
const customTools: any[] = createAllToolDefinitions();
const customToolNames = customTools.map((t: any) => t.name);
const builtInToolNames = ["read", "bash", "edit", "write"];
const allToolNames = [...builtInToolNames, ...customToolNames];

// ─── Session state ───────────────────────────────────────────────────────────

let sessionId = `web-${Date.now()}`;
let sessionFile = resolveSessionFile(sessionId);
let activeSession: any = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendSSE(res: http.ServerResponse, event: string, data: any) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody(req);
  let message: string;
  try {
    message = JSON.parse(body).message;
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON. Expected { message: string }" });
    return;
  }

  if (!message?.trim()) {
    jsonResponse(res, 400, { error: "Empty message" });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const sessionManager = SessionManager.open(sessionFile);
    const settingsManager = SettingsManager.create(workspaceDir, AGENT_DIR);

    const systemPrompt = buildSystemPrompt({
      workspaceDir,
      runtime,
      toolNames: allToolNames,
      contextFiles,
      thinkingLevel: "off",
    });

    const { session } = await createAgentSession({
      cwd: workspaceDir,
      agentDir: AGENT_DIR,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "off",
      customTools,
      sessionManager,
      settingsManager,
    });

    applySystemPromptToSession(session, systemPrompt);
    session.agent.streamFn = streamSimple;
    activeSession = session;

    // Subscribe to events and forward as SSE
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      try {
        switch (event.type) {
          case "message_update": {
            const aEvent = (event as any).assistantMessageEvent;
            if (aEvent?.type === "text_delta") {
              sendSSE(res, "text_delta", { delta: aEvent.delta });
            } else if (aEvent?.type === "thinking_delta") {
              sendSSE(res, "thinking_delta", { delta: aEvent.delta });
            }
            break;
          }
          case "tool_execution_start":
            sendSSE(res, "tool_start", {
              id: (event as any).toolCallId,
              name: (event as any).toolName,
            });
            break;
          case "tool_execution_end":
            sendSSE(res, "tool_end", {
              id: (event as any).toolCallId,
              name: (event as any).toolName,
              isError: (event as any).isError,
            });
            break;
          case "agent_end":
            sendSSE(res, "done", {});
            unsubscribe();
            session.dispose();
            activeSession = null;
            res.end();
            break;
        }
      } catch {
        // Client disconnected, ignore write errors
      }
    });

    // Handle client disconnect
    req.on("close", () => {
      unsubscribe();
    });

    // Send the prompt
    await session.prompt(message.trim());
  } catch (err: any) {
    sendSSE(res, "error", { error: err.message });
    res.end();
  }
}

function handleNewSession(_req: http.IncomingMessage, res: http.ServerResponse) {
  if (activeSession) {
    activeSession.dispose();
    activeSession = null;
  }
  sessionId = `web-${Date.now()}`;
  sessionFile = resolveSessionFile(sessionId);
  jsonResponse(res, 200, { sessionId });
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  jsonResponse(res, 200, {
    provider,
    model: modelId,
    sessionId,
    tools: allToolNames,
  });
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method?.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (method === "POST" && url.pathname === "/api/chat") {
    await handleChat(req, res);
  } else if (method === "POST" && url.pathname === "/api/session/new") {
    handleNewSession(req, res);
  } else if (method === "GET" && url.pathname === "/api/status") {
    handleStatus(req, res);
  } else if (method === "GET") {
    // Try serving static file from web/dist, SPA fallback to index.html
    if (!serveStatic(res, url.pathname)) {
      serveStatic(res, "/index.html") || jsonResponse(res, 404, { error: "Not found" });
    }
  } else {
    jsonResponse(res, 404, { error: "Not found" });
  }
});

server.listen(PORT, () => {
  console.log(`\x1b[2m┌ civilclaw web server\x1b[0m`);
  console.log(`\x1b[2m│ http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[2m│ model: ${provider}/${modelId}\x1b[0m`);
  console.log(`\x1b[2m│ workspace: ${workspaceDir}\x1b[0m`);
  console.log(`\x1b[2m└ session: ${sessionId}\x1b[0m`);
});
