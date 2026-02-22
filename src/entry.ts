#!/usr/bin/env node
/**
 * civilclaw: Terminal-only AI agent with full coding intelligence.
 *
 * Uses the PI SDK directly — same engine as civilclaw, no channel overhead.
 * Enhanced with: rich system prompt, web tools, context file loading.
 */
import {
  loadDotEnv,
  ensureDirs,
  ensureApiKeyInEnv,
  resolveModelAndAuth,
  resolveSessionFile,
  applySystemPromptToSession,
  extractAssistantText,
  extractToolCalls,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  AGENT_DIR,
  ENV_KEY_MAP,
} from "./shared.js";

// Load env before any other imports that might need keys
loadDotEnv();

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  buildSystemPrompt,
  detectRuntime,
  loadContextFiles,
} from "./system-prompt.js";
import { createAllToolDefinitions } from "./tools/index.js";

// ─── Custom tools ────────────────────────────────────────────────────────────

function buildCustomTools(): any[] {
  return createAllToolDefinitions();
}

// ─── REPL ────────────────────────────────────────────────────────────────────

type ThinkingLevel = "off" | "on" | "stream";

async function main() {
  ensureDirs();

  const provider = DEFAULT_PROVIDER;
  const modelId = DEFAULT_MODEL;
  const workspaceDir = process.cwd();
  let sessionId = `mini-${Date.now()}`;
  let sessionFile = resolveSessionFile(sessionId);
  let thinkingLevel: ThinkingLevel = "off";

  // Ensure API key is available
  const hasKey = ensureApiKeyInEnv(provider);
  if (!hasKey) {
    const envKey = ENV_KEY_MAP[provider]?.[0] ?? `${provider.toUpperCase()}_API_KEY`;
    console.error(`No API key found for ${provider}.`);
    console.error(`Set ${envKey} or run "civilclaw configure" to set up auth.`);
    process.exit(1);
  }

  const { model, authStorage, modelRegistry } = resolveModelAndAuth(provider, modelId);

  // Build system prompt
  const runtime = detectRuntime(provider, modelId);
  const contextFiles = loadContextFiles(workspaceDir);
  const customTools = buildCustomTools();
  const customToolNames = customTools.map((t: any) => t.name);

  // The PI SDK provides these built-in tools (read, bash, edit, write are default active)
  const builtInToolNames = ["read", "bash", "edit", "write"];
  const allToolNames = [...builtInToolNames, ...customToolNames];

  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    runtime,
    toolNames: allToolNames,
    contextFiles,
    thinkingLevel,
  });

  console.log(`\x1b[2m┌ civilclaw\x1b[0m`);
  console.log(`\x1b[2m│ model: ${provider}/${modelId}\x1b[0m`);
  console.log(`\x1b[2m│ workspace: ${workspaceDir}\x1b[0m`);
  console.log(`\x1b[2m│ session: ${sessionId}\x1b[0m`);
  console.log(
    `\x1b[2m│ context: ${contextFiles.length > 0 ? contextFiles.map((f) => f.path).join(", ") : "none"}\x1b[0m`,
  );
  console.log(`\x1b[2m│ tools: ${allToolNames.join(", ")}\x1b[0m`);
  console.log(`\x1b[2m└ /new /think /model /quit\x1b[0m`);
  console.log();

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    let input: string;
    try {
      input = await rl.question("\x1b[1m> \x1b[0m");
    } catch {
      break; // EOF
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // Slash commands
    if (trimmed === "/quit" || trimmed === "/exit") break;
    if (trimmed === "/new") {
      sessionId = `mini-${Date.now()}`;
      sessionFile = resolveSessionFile(sessionId);
      console.log(`\x1b[2mNew session: ${sessionId}\x1b[0m\n`);
      continue;
    }
    if (trimmed.startsWith("/model")) {
      console.log(`\x1b[2mCurrent: ${provider}/${modelId}\x1b[0m`);
      console.log(
        `\x1b[2mChange via CIVILCLAW_PROVIDER and CIVILCLAW_MODEL env vars.\x1b[0m\n`,
      );
      continue;
    }
    if (trimmed === "/think" || trimmed.startsWith("/think ")) {
      const arg = trimmed.slice("/think".length).trim().toLowerCase();
      if (arg === "off" || arg === "on" || arg === "stream") {
        thinkingLevel = arg;
      } else {
        // Toggle
        thinkingLevel = thinkingLevel === "off" ? "on" : "off";
      }
      console.log(`\x1b[2mThinking: ${thinkingLevel}\x1b[0m\n`);
      continue;
    }
    if (trimmed === "/status") {
      console.log(`\x1b[2mModel: ${provider}/${modelId}\x1b[0m`);
      console.log(`\x1b[2mSession: ${sessionId}\x1b[0m`);
      console.log(`\x1b[2mThinking: ${thinkingLevel}\x1b[0m`);
      console.log(`\x1b[2mWorkspace: ${workspaceDir}\x1b[0m`);
      console.log(
        `\x1b[2mContext files: ${contextFiles.length > 0 ? contextFiles.map((f) => f.path).join(", ") : "none"}\x1b[0m\n`,
      );
      continue;
    }

    // Run agent
    const startTime = Date.now();
    try {
      const sessionManager = SessionManager.open(sessionFile);
      const settingsManager = SettingsManager.create(workspaceDir, AGENT_DIR);

      // Rebuild system prompt with current thinking level
      const currentSystemPrompt = buildSystemPrompt({
        workspaceDir,
        runtime,
        toolNames: allToolNames,
        contextFiles,
        thinkingLevel,
      });

      const { session } = await createAgentSession({
        cwd: workspaceDir,
        agentDir: AGENT_DIR,
        authStorage,
        modelRegistry,
        model,
        thinkingLevel: (thinkingLevel === "stream" ? "on" : thinkingLevel) as any,
        customTools,
        sessionManager,
        settingsManager,
      });

      // Override the SDK's default system prompt with our enriched one
      applySystemPromptToSession(session, currentSystemPrompt);

      session.agent.streamFn = streamSimple;

      await session.prompt(trimmed);

      // Check for silent errors
      const agentError = session.agent.state.error;
      if (agentError) {
        console.error(`\x1b[31mAgent error: ${agentError}\x1b[0m`);
      }

      // Extract and display results
      const toolCalls = extractToolCalls(session.messages);
      if (toolCalls.length > 0) {
        console.log(
          `\x1b[2m[tools: ${toolCalls.join(", ")}]\x1b[0m`,
        );
      }

      const text = session.getLastAssistantText() ?? extractAssistantText(session.messages);
      if (text) {
        console.log(text);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\x1b[2m(${elapsed}s)\x1b[0m\n`);

      session.dispose();
    } catch (err: any) {
      console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
      if (err.cause) {
        console.error(`\x1b[2m${String(err.cause)}\x1b[0m`);
      }
      console.log();
    }
  }

  rl.close();
  console.log("\x1b[2mBye.\x1b[0m");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
