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
import { createFileStore } from "./file-store.js";
import type { FileMetadata } from "./file-store.js";
import { Busboy } from "@fastify/busboy";
import { extractPdfText } from "./pdf-extractor.js";
import { processAttachedFiles } from "./file-content-processor.js";

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

// ─── File store ─────────────────────────────────────────────────────────────

const fileStore = createFileStore();

// ─── Session state ───────────────────────────────────────────────────────────

let sessionId = `web-${Date.now()}`;
let sessionFile = resolveSessionFile(sessionId);
let activeSession: any = null;

// Eagerly create workspace for initial session
fileStore.ensureWorkspace(sessionId);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
  let attachedFileRefs: Array<{ filename: string }> = [];
  try {
    const parsed = JSON.parse(body);
    message = parsed.message;
    attachedFileRefs = parsed.files ?? [];
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON. Expected { message: string, files?: [...] }" });
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
    const sessionWorkspace = fileStore.ensureWorkspace(sessionId);
    const sessionManager = SessionManager.open(sessionFile);
    const settingsManager = SettingsManager.create(workspaceDir, AGENT_DIR);

    const systemPrompt = buildSystemPrompt({
      workspaceDir,
      sessionWorkspaceDir: sessionWorkspace,
      runtime,
      toolNames: allToolNames,
      contextFiles,
      thinkingLevel: "off",
    });

    const { session } = await createAgentSession({
      cwd: sessionWorkspace,
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
          case "agent_end": {
            unsubscribe();
            // Sync any files created by tools during this turn
            const newFiles = fileStore.syncNewFiles(sessionId);
            if (newFiles.length > 0) {
              sendSSE(res, "files_updated", {
                files: newFiles.map((f) => ({
                  filename: f.filename,
                  originalName: f.originalName,
                  size: f.size,
                  mimeType: f.mimeType,
                  source: f.source,
                })),
              });
            }
            sendSSE(res, "done", {});
            session.dispose();
            activeSession = null;
            res.end();
            break;
          }
        }
      } catch {
        // Client disconnected, ignore write errors
      }
    });

    // Handle client disconnect
    req.on("close", () => {
      unsubscribe();
    });

    // Resolve attached files from the store and process their content
    const resolvedFiles: FileMetadata[] = attachedFileRefs
      .map((ref) => fileStore.getFileMetadata(sessionId, ref.filename))
      .filter((m): m is FileMetadata => m !== null);

    const { contextText, images, warnings } = await processAttachedFiles(
      resolvedFiles,
      sessionId,
      fileStore,
    );

    if (warnings.length > 0) {
      sendSSE(res, "file_warnings", { warnings });
    }

    // Build augmented prompt with file content prepended
    let augmentedMessage = message.trim();
    if (contextText) {
      augmentedMessage = contextText + "\n\n" + augmentedMessage;
    }

    // Send the prompt (with image content blocks if any)
    await session.prompt(augmentedMessage, images.length > 0 ? { images } : undefined);
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
  fileStore.ensureWorkspace(sessionId);
  jsonResponse(res, 200, { sessionId });
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  jsonResponse(res, 200, {
    provider,
    model: modelId,
    sessionId,
    tools: allToolNames,
    workspaceDir: fileStore.workspaceDir(sessionId),
  });
}

// ─── File routes ────────────────────────────────────────────────────────────

async function handleFileUpload(req: http.IncomingMessage, res: http.ServerResponse) {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("multipart/form-data")) {
    jsonResponse(res, 400, { error: "Expected multipart/form-data" });
    return;
  }

  return new Promise<void>((resolve) => {
    const busboy = Busboy({ headers: req.headers as any });
    const uploads: Promise<FileMetadata>[] = [];

    busboy.on("file", (_fieldname: string, stream: any, info: any) => {
      const { filename, mimeType } = info;
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const data = Buffer.concat(chunks);
        const saveName = filename || "unnamed";
        uploads.push(
          (async () => {
            const meta = fileStore.saveFile({
              sessionId,
              filename: saveName,
              data,
              mimeType,
              source: "upload",
            });

            // Extract text from PDFs at upload time
            if (mimeType === "application/pdf" || saveName.toLowerCase().endsWith(".pdf")) {
              try {
                const { text, numPages } = await extractPdfText(data);
                fileStore.updateFileMetadata(sessionId, meta.filename, {
                  extractedText: text.slice(0, 200_000),
                  extractedPages: numPages,
                });
                meta.extractedText = text.slice(0, 200_000);
                meta.extractedPages = numPages;
              } catch (err) {
                console.warn(`PDF text extraction failed for ${saveName}:`, err);
              }
            }

            return meta;
          })(),
        );
      });
    });

    busboy.on("finish", async () => {
      try {
        const results = await Promise.all(uploads);
        jsonResponse(res, 200, { files: results });
      } catch (err: any) {
        jsonResponse(res, 500, { error: err.message });
      }
      resolve();
    });

    busboy.on("error", (err: Error) => {
      jsonResponse(res, 500, { error: err.message });
      resolve();
    });

    req.pipe(busboy);
  });
}

function handleFileList(_req: http.IncomingMessage, res: http.ServerResponse) {
  fileStore.syncNewFiles(sessionId);
  const files = fileStore.listFiles(sessionId);
  jsonResponse(res, 200, { sessionId, files });
}

function handleFileDownload(_req: http.IncomingMessage, res: http.ServerResponse, filename: string) {
  const meta = fileStore.getFileMetadata(sessionId, filename);
  if (!meta) {
    jsonResponse(res, 404, { error: "File not found" });
    return;
  }

  try {
    const data = fileStore.readFile(sessionId, filename);
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": meta.mimeType,
      "Content-Length": data.length.toString(),
      "Content-Disposition": `inline; filename="${meta.originalName}"`,
    });
    res.end(data);
  } catch {
    jsonResponse(res, 404, { error: "File not found" });
  }
}

function handleFileDelete(_req: http.IncomingMessage, res: http.ServerResponse, filename: string) {
  const deleted = fileStore.deleteFile(sessionId, filename);
  if (!deleted) {
    jsonResponse(res, 404, { error: "File not found" });
    return;
  }
  jsonResponse(res, 200, { deleted: true, filename });
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
  } else if (method === "POST" && url.pathname === "/api/files/upload") {
    await handleFileUpload(req, res);
  } else if (method === "GET" && url.pathname === "/api/status") {
    handleStatus(req, res);
  } else if (method === "GET" && url.pathname === "/api/files") {
    handleFileList(req, res);
  } else if (method === "GET" && url.pathname.startsWith("/api/files/")) {
    const filename = decodeURIComponent(url.pathname.slice("/api/files/".length));
    handleFileDownload(req, res, filename);
  } else if (method === "DELETE" && url.pathname.startsWith("/api/files/")) {
    const filename = decodeURIComponent(url.pathname.slice("/api/files/".length));
    handleFileDelete(req, res, filename);
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
