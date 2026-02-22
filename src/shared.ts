/**
 * Shared setup code used by both the CLI (entry.ts) and the web server (server.ts).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ─── .env loading ────────────────────────────────────────────────────────────

export function loadDotEnv() {
  try {
    const envPath = path.join(process.cwd(), ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — that's fine
  }
}

// Load .env immediately so env vars are available for module-level constants
loadDotEnv();

// ─── Configuration ───────────────────────────────────────────────────────────

export const CIVILCLAW_HOME = path.join(os.homedir(), ".civilclaw");
export const AGENT_ID = process.env.CIVILCLAW_AGENT ?? "main";
export const AGENT_DIR = path.join(CIVILCLAW_HOME, "agents", AGENT_ID, "agent");
export const MODELS_JSON = path.join(AGENT_DIR, "models.json");
export const AUTH_PROFILES_JSON = path.join(AGENT_DIR, "auth-profiles.json");
export const SESSION_DIR = path.join(CIVILCLAW_HOME, "state", "sessions", "mini");

export const DEFAULT_PROVIDER = process.env.CIVILCLAW_PROVIDER ?? "anthropic";
export const DEFAULT_MODEL = process.env.CIVILCLAW_MODEL ?? "claude-sonnet-4-20250514";

// ─── Ensure directories ─────────────────────────────────────────────────────

export function ensureDirs() {
  for (const dir of [CIVILCLAW_HOME, AGENT_DIR, SESSION_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

type AuthProfile = { type: string; provider: string; token?: string };
type AuthProfiles = {
  profiles?: Record<string, AuthProfile>;
  lastGood?: Record<string, string>;
};

function loadApiKeyFromProfiles(provider: string): string | undefined {
  try {
    const raw = fs.readFileSync(AUTH_PROFILES_JSON, "utf-8");
    const data: AuthProfiles = JSON.parse(raw);
    const profiles = data.profiles ?? {};

    const lastGoodKey = data.lastGood?.[provider];
    if (lastGoodKey && profiles[lastGoodKey]?.token) {
      return profiles[lastGoodKey]!.token;
    }

    for (const profile of Object.values(profiles)) {
      if (profile.provider === provider && profile.token) {
        return profile.token;
      }
    }
  } catch {
    // File doesn't exist or can't be parsed
  }
  return undefined;
}

export const ENV_KEY_MAP: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
};

export function ensureApiKeyInEnv(provider: string): boolean {
  const envKeys = ENV_KEY_MAP[provider] ?? [`${provider.toUpperCase()}_API_KEY`];

  for (const envKey of envKeys) {
    if (process.env[envKey]) return true;
  }

  const apiKey = loadApiKeyFromProfiles(provider);
  if (apiKey && envKeys[0]) {
    process.env[envKeys[0]] = apiKey;
    return true;
  }

  return false;
}

// ─── Model resolution ────────────────────────────────────────────────────────

function resolveApiType(provider: string): string {
  const apiMap: Record<string, string> = {
    anthropic: "anthropic",
    openai: "openai-responses",
    google: "google",
    ollama: "ollama",
    groq: "openai",
    xai: "openai",
    mistral: "openai",
    openrouter: "openai",
    cerebras: "openai",
  };
  return apiMap[provider] ?? "openai";
}

export function resolveModelAndAuth(provider: string, modelId: string) {
  const authJsonPath = path.join(AGENT_DIR, "auth.json");
  const authStorage = new AuthStorage(authJsonPath);
  const modelRegistry = new ModelRegistry(authStorage, MODELS_JSON);

  let model = modelRegistry.find(provider, modelId) as Model<Api> | null;

  if (!model) {
    const apiType = resolveApiType(provider);
    model = {
      id: modelId,
      name: modelId,
      api: apiType,
      provider,
      input: ["text", "image"],
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    } as Model<Api>;
  }

  return { model, authStorage, modelRegistry };
}

// ─── Session management ──────────────────────────────────────────────────────

export function resolveSessionFile(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

// ─── System prompt override ──────────────────────────────────────────────────

export function applySystemPromptToSession(
  session: any,
  systemPrompt: string,
) {
  session.agent.setSystemPrompt(systemPrompt);
  const mutable = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutable._baseSystemPrompt = systemPrompt;
  mutable._rebuildSystemPrompt = () => systemPrompt;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function extractAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("");
      if (text) return text;
    }
  }
  return "";
}

export function extractToolCalls(messages: AgentMessage[]): string[] {
  const toolCalls: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if ((part as any).type === "tool_use") {
        toolCalls.push((part as any).name ?? "unknown");
      }
    }
  }
  return toolCalls;
}
