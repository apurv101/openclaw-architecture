# civilclaw Feature Roadmap

civilclaw is a lightweight terminal AI agent (~1,076 lines, 4 source files) built on the `pi-coding-agent` SDK. Compared to the full openclaw (100+ source files), it's missing several major AI features that significantly impact user experience.

This document describes **9 features** to implement, ordered by effort (easiest first), with detailed implementation plans.

> **Key discovery:** The `pi-coding-agent` SDK already has built-in support for compaction, thinking levels, session stats (tokens + cost), skills, and agent events. Many features just need wiring, not reimplementation.

---

## Overview

| # | Feature | Effort | Impact | SDK Support |
|---|---------|--------|--------|-------------|
| 1 | [Richer Thinking Levels](#1-richer-thinking-levels) | Trivial | Low-Medium | Full — just use `ThinkingLevel` type |
| 2 | [Usage & Cost Tracking](#2-usage--cost-tracking) | Small | Medium | Full — `getSessionStats()` |
| 3 | [Tool Loop Detection](#3-tool-loop-detection) | Small-Medium | High | Partial — events exist, logic is new |
| 4 | [Conversation Compaction](#4-conversation-compaction) | Small | High | Full — built-in auto-compaction |
| 5 | [Skills / Plugin System](#5-skills--plugin-system) | Small-Medium | Medium | Full — `loadSkills()` + `formatSkillsForPrompt()` |
| 6 | [Model Fallback Chains](#6-model-fallback-chains) | Small-Medium | Medium | Partial — retry exists, cross-model is new |
| 7 | [Subagent System](#7-subagent-system) | Medium-Large | Medium-High | None — build from scratch |
| 8 | [Hooks / Middleware](#8-hooks--middleware-system) | Medium | Medium | None — build from scratch |
| 9 | [Memory System](#9-memory-system) | Large | Very High | None — build from scratch |

---

## 1. Richer Thinking Levels

### What it does

Expands thinking control from 3 levels (`off`/`on`/`stream`) to 6 levels (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`). The SDK's `ThinkingLevel` type already supports all 6 — civilclaw just hardcodes 3.

### Why it matters

More granular control over reasoning depth. Quick tasks don't need deep thinking (saves tokens and time), complex tasks benefit from extended reasoning. `xhigh` enables OpenAI's extended thinking on supported models (gpt-5.2, gpt-5.3-codex).

### Files to modify

- `src/entry.ts` — Update `ThinkingLevel` type, `/think` command, and `createAgentSession` call

### Implementation

1. Replace `type ThinkingLevel = "off" | "on" | "stream"` with the SDK's `ThinkingLevel` import from `@mariozechner/pi-agent-core`
2. Update `/think` command to accept: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
3. Keep `stream` as an alias that maps to `high` + streaming enabled
4. Remove the `(thinkingLevel === "stream" ? "on" : thinkingLevel) as any` hack — pass the level directly
5. Update `/think` toggle to cycle: `off` → `low` → `medium` → `high` → `off`
6. Display current level in `/status`

### SDK reference

```typescript
// @mariozechner/pi-agent-core/dist/types.d.ts
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

---

## 2. Usage & Cost Tracking

### What it does

Shows token usage (input/output/cache) and estimated cost after each interaction. Accumulates per session.

### Why it matters

Users have zero visibility into how many tokens they're spending. This is critical for cost management, especially with expensive models or long sessions.

### Files to modify

- `src/entry.ts` — Call `getSessionStats()` after each prompt, format display

### Implementation

1. After `await session.prompt(trimmed)`, call `session.getSessionStats()`
2. Format the elapsed line:
   ```
   (12.3s | 4.2k in + 1.1k out | $0.03)
   ```
3. Keep a running session total by accumulating across prompts
4. Add `/usage` command to show detailed breakdown:
   ```
   Session: mini-1708444800000
   Input tokens:   12,450
   Output tokens:   3,210
   Cache read:      8,100
   Cache write:     2,300
   Total tokens:   26,060
   Estimated cost:  $0.12
   Tool calls:      15
   ```
5. Optional: Track cumulative across sessions by writing to a usage log file

### SDK reference

```typescript
// AgentSession.getSessionStats() returns:
interface SessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  toolCalls: number;
  userMessages: number;
  assistantMessages: number;
  totalMessages: number;
}
```

---

## 3. Tool Loop Detection

### What it does

Detects when the agent is stuck in loops — repeating the same tool call, ping-ponging between two tools, or making too many calls in a row. Injects a warning message to break the pattern.

### Why it matters

Without this, the agent can get stuck retrying failed operations infinitely, burning tokens and time. This is a common failure mode in agentic systems. The full openclaw has a 623-line implementation covering generic repeat detection, ping-pong detection, and a global circuit breaker.

### New files

- `src/tool-loop-detection.ts` (~150 lines)

### Files to modify

- `src/entry.ts` — Subscribe to agent events, wire loop detector

### Implementation

#### Data structures

```typescript
interface ToolCallRecord {
  name: string;
  argsHash: string;    // simple hash of JSON.stringify(args)
  timestamp: number;
}

interface LoopDetector {
  history: ToolCallRecord[];    // ring buffer, last 30 calls
  record(name: string, args: any): void;
  check(): LoopDetection | null;
  reset(): void;
}

type LoopDetection =
  | { type: "repeat"; tool: string; count: number }           // same call 3+ times
  | { type: "pingpong"; tools: [string, string]; count: number } // alternating A-B-A-B
  | { type: "circuit_breaker"; count: number };                // >30 calls total
```

#### Detection algorithms

1. **Repeat detection:** Last 3+ entries have same `name` + `argsHash`
2. **Ping-pong detection:** Last 4+ entries alternate between exactly 2 tools
3. **Circuit breaker:** Total tool calls in current agent run exceeds 30

#### Integration

- Subscribe to `AgentSession` events via `session.subscribe()`
- On `tool_execution_end` event, call `detector.record()` then `detector.check()`
- On detection, use `session.steer()` to inject:
  ```
  LOOP DETECTED: You've called {tool} {N} times with the same arguments.
  Try a different approach or explain what's blocking you.
  ```
- Reset detector on each new user prompt

---

## 4. Conversation Compaction

### What it does

When the conversation approaches the context window limit, automatically summarizes older messages to free space. Enables arbitrarily long coding sessions without hitting the context wall.

### Why it matters

civilclaw currently has no strategy for when conversations exceed the context window. Long coding sessions will just fail or lose context. Compaction lets users have infinite-length sessions.

### Files to modify

- `src/entry.ts` — Subscribe to compaction events, add `/compact` command

### Implementation

The SDK's `AgentSession` already has **full compaction support built-in**:

1. **Auto-compaction triggers automatically** when context approaches the limit. `AgentSession` has internal `_checkCompaction()` and `_runAutoCompaction()`.

2. **Wire event listeners** to show compaction status in the terminal:
   ```typescript
   session.subscribe((event) => {
     if (event.type === "auto_compaction_start") {
       console.log("\x1b[2m[compacting context...]\x1b[0m");
     }
     if (event.type === "auto_compaction_end") {
       if (event.result) {
         console.log(`\x1b[2m[compacted: ${event.result.tokensBefore} tokens summarized]\x1b[0m`);
       }
     }
   });
   ```

3. **Add `/compact` command** for manual compaction:
   ```typescript
   if (trimmed === "/compact") {
     const result = await session.compact();
     console.log(`Compacted: ${result.tokensBefore} tokens summarized`);
     continue;
   }
   ```

4. **Add `/compact off` and `/compact on`** to toggle auto-compaction:
   ```typescript
   session.setAutoCompactionEnabled(true);  // or false
   ```

### SDK reference

```typescript
// Already in AgentSession:
compact(customInstructions?: string): Promise<CompactionResult>;
setAutoCompactionEnabled(enabled: boolean): void;
get autoCompactionEnabled(): boolean;
get isCompacting(): boolean;

// Events:
type AgentSessionEvent =
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | { type: "auto_compaction_end"; result: CompactionResult | undefined; aborted: boolean }

interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}
```

---

## 5. Skills / Plugin System

### What it does

Users can extend the agent's capabilities by dropping `SKILL.md` files in the workspace or `~/.civilclaw/skills/`. These get discovered, loaded, and injected into the system prompt as available skills.

### Why it matters

Skills let users extend the agent's capabilities without modifying core code. A user could drop a `SKILL.md` file to teach the agent about their specific workflows, coding standards, or deployment processes.

### Files to modify

- `src/system-prompt.ts` — Add skills section to prompt
- `src/entry.ts` — Load skills at startup, pass to prompt builder

### Implementation

1. **Use SDK's built-in skill loading:**
   ```typescript
   import { loadSkills, formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";

   const { skills, diagnostics } = loadSkills({
     cwd: workspaceDir,
     agentDir: AGENT_DIR,
     includeDefaults: true,
   });
   ```

2. **Discovery locations** (SDK handles this automatically):
   - `{workspaceDir}/*.md` — direct markdown children
   - `{workspaceDir}/**/SKILL.md` — recursive SKILL.md files
   - `{agentDir}/skills/` — global skills directory

3. **Add to system prompt** in `buildSystemPrompt()`:
   ```typescript
   if (skills.length > 0) {
     lines.push("## Skills");
     lines.push(formatSkillsForPrompt(skills));
     lines.push("");
   }
   ```

4. **Skill invocation:** The SDK's `AgentSession` already handles `/skill:name` expansion via `_expandSkillCommand()`. Just ensure skills are loaded into the `ResourceLoader`.

5. **Display at startup:** Show loaded skills count in the banner.

6. **Add `/skills` command** to list available skills with descriptions.

### SKILL.md format

```markdown
---
name: git-commit
description: Create well-formatted git commits
---

When asked to commit, follow these steps:
1. Run `git diff --staged` to see changes
2. Write a conventional commit message
3. Run `git commit -m "..."` with the message
```

### SDK reference

```typescript
// @mariozechner/pi-coding-agent/dist/core/skills.d.ts
interface Skill {
  name: string;
  description: string;
  filePath: string;
  source: string;
  disableModelInvocation: boolean;
}

function loadSkills(options?: LoadSkillsOptions): LoadSkillsResult;
function formatSkillsForPrompt(skills: Skill[]): string;
```

---

## 6. Model Fallback Chains

### What it does

When the primary model/provider fails (rate limit, timeout, auth error), automatically tries alternative models. Configurable via environment variables.

### Why it matters

If the configured model is down or rate-limited, civilclaw just fails. Fallback chains make it resilient — it can try Anthropic, then OpenAI, then Gemini automatically.

### New files

- `src/model-fallback.ts` (~120 lines)

### Files to modify

- `src/entry.ts` — Wrap `session.prompt()` with fallback logic

### Implementation

#### Configuration

```bash
# .env
CIVILCLAW_FALLBACK_MODELS=openai/gpt-4.1,anthropic/claude-sonnet-4-20250514,google/gemini-2.5-pro
```

#### Data structures

```typescript
interface FallbackConfig {
  models: Array<{ provider: string; modelId: string }>;
  cooldownMs: number;       // default: 60000 (1 min)
  maxRetries: number;       // default: 2
}

interface ProviderCooldown {
  provider: string;
  failedAt: number;
  cooldownUntil: number;
}
```

#### Logic

1. Parse `CIVILCLAW_FALLBACK_MODELS` at startup into ordered list
2. On API error (429, 500, 503, timeout, auth failure), check if retryable
3. Find next model not in cooldown
4. Re-resolve auth for the fallback provider via `ensureApiKeyInEnv()`
5. Re-create session with fallback model
6. Put failed provider in cooldown
7. Display: `[fallback: switched to openai/gpt-4.1]`

> **Note:** The SDK already has `_isRetryableError` and `_handleRetryableError` for same-model retries. Fallback adds cross-model resilience on top.

---

## 7. Subagent System

### What it does

The agent can spawn child agents for parallel or delegated work. Each subagent gets its own focused session, runs to completion, and reports results back to the parent.

### Why it matters

Complex tasks (e.g., "refactor these 5 files" or "research X while implementing Y") could be parallelized. The agent could spawn a subagent to research while it codes. The full openclaw has a complete subagent registry with depth tracking, announce queues, and nesting support.

### New files

- `src/subagent/registry.ts` (~100 lines) — Track active subagents
- `src/subagent/spawn.ts` (~150 lines) — Spawn and run child sessions
- `src/subagent/tool.ts` (~200 lines) — Tool definitions for spawn/manage
- `src/subagent/prompt.ts` (~60 lines) — Subagent system prompt builder

### Files to modify

- `src/entry.ts` — Register subagent tools, pass shared config
- `src/system-prompt.ts` — Add subagent instructions to prompt

### Implementation

#### Registry

```typescript
interface SubagentRun {
  id: string;                    // unique run ID
  label: string;                 // user-friendly label
  task: string;                  // the task description
  sessionFile: string;           // child session file path
  status: "running" | "completed" | "error" | "timeout";
  startedAt: number;
  completedAt?: number;
  result?: string;               // final assistant text
  promise: Promise<SubagentResult>;
}

class SubagentRegistry {
  private runs: Map<string, SubagentRun> = new Map();
  private maxChildren = 3;       // max concurrent subagents
  private maxDepth = 1;          // no grandchildren by default

  register(run: SubagentRun): void;
  get(id: string): SubagentRun | undefined;
  listActive(): SubagentRun[];
  markCompleted(id: string, result: string): void;
  markError(id: string, error: string): void;
  canSpawn(): boolean;
}
```

#### Spawn logic

```typescript
async function spawnSubagent(params: {
  task: string;
  label?: string;
  registry: SubagentRegistry;
  parentConfig: {
    model; authStorage; modelRegistry;
    workspaceDir; agentDir; settingsManager;
  };
}): Promise<SubagentRun> {
  // 1. Validate: registry.canSpawn()
  // 2. Create child session file: SESSION_DIR/sub-{timestamp}.json
  // 3. Create child AgentSession via createAgentSession() (same model/auth)
  // 4. Apply subagent-specific system prompt (focused on task)
  // 5. Run session.prompt(task) as a background Promise
  // 6. On completion: extract result text, mark completed in registry
  // 7. Return run handle immediately (parent continues working)
}
```

#### Subagent system prompt

```
You are a subagent spawned for a specific task.

## Your Task
{TASK}

## Rules
1. Complete this task — that's your entire purpose.
2. Stay focused — don't do anything beyond the task.
3. Be concise — your final message is reported to the parent agent.
4. You are ephemeral — you'll be terminated after completion.
5. Do NOT interact with the user directly.

## Output
Provide a clear summary of what you accomplished or found.
```

#### Tool definitions

**`spawn_subagent` tool:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | The task to delegate |
| `label` | string | No | Short label for tracking |

Returns `{ runId, status: "accepted" }`. The parent agent continues working while the subagent runs concurrently.

**`manage_subagents` tool:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"list"` \| `"kill"` \| `"check"` | Yes | What to do |
| `runId` | string | No | Target subagent (for kill/check) |

- `list` — Returns all active/completed subagents with status
- `kill` — Aborts a running subagent
- `check` — Gets detailed result from a completed subagent

#### Result delivery

When a subagent completes, inject a message into the parent session:

```
[Subagent "research API docs" completed]:
Found 3 relevant endpoints: GET /users, POST /users, DELETE /users/{id}.
Authentication uses Bearer tokens. Rate limit is 100 req/min.
```

- If parent is idle: use `session.followUp()` to trigger a new turn
- If parent is busy: queue as follow-up message (delivered when parent finishes)

#### System prompt addition

```
## Subagents
You can spawn subagents for parallel or delegated work:
- spawn_subagent: Create a child agent for a specific task (runs concurrently)
- manage_subagents: List, check, or kill running subagents

Use subagents when:
- A task can be parallelized (e.g., "research X while I implement Y")
- A task is self-contained and doesn't need your direct involvement
- You want to delegate exploration/search while you continue working

Subagent results are automatically reported back to you when they complete.
```

---

## 8. Hooks / Middleware System

### What it does

Lets users customize agent behavior via hook scripts that run at key lifecycle points. Hooks can modify prompts, intercept tool calls, handle errors, or add custom behavior — without forking the codebase.

### Why it matters

It's the difference between a closed tool and an extensible platform. Users can add audit logging, prompt modifications, tool restrictions, or custom error recovery that survives updates. The full openclaw has hooks for `before_model_resolve`, `before_prompt_build`, `after_tool_call`, `on_llm_error`, and more.

### New files

- `src/hooks/types.ts` (~40 lines) — Hook type definitions
- `src/hooks/loader.ts` (~80 lines) — Discover and load hooks
- `src/hooks/runner.ts` (~120 lines) — Execute hooks at lifecycle points

### Files to modify

- `src/entry.ts` — Initialize hooks, wire into agent lifecycle

### Implementation

#### Hook events

| Event | When it fires | What you can do |
|-------|--------------|-----------------|
| `before_prompt` | Before system prompt is built | Add context to the prompt |
| `after_tool_call` | After any tool executes | Log, audit, or block operations |
| `on_error` | When an LLM or tool error occurs | Custom error handling, alerting |
| `before_response` | Before displaying response to user | Transform output |
| `on_session_start` | When a new session begins | Initialize session-specific state |

#### Types

```typescript
type HookEvent =
  | "before_prompt"
  | "after_tool_call"
  | "on_error"
  | "before_response"
  | "on_session_start";

interface HookDefinition {
  event: HookEvent;
  handler: string;       // path to JS module or shell command
  priority?: number;     // lower = runs first (default: 100)
}

interface HookContext {
  event: HookEvent;
  sessionId: string;
  model: string;
  workspaceDir: string;
  toolName?: string;     // for after_tool_call
  toolArgs?: any;        // for after_tool_call
  toolResult?: any;      // for after_tool_call
  error?: string;        // for on_error
  systemPrompt?: string; // for before_prompt
}

interface HookResult {
  modified?: boolean;
  systemPromptAddition?: string;   // for before_prompt
  blockToolCall?: boolean;          // for after_tool_call
  message?: string;                 // for on_error
}
```

#### Discovery

1. `.civilclaw/hooks/` in workspace — project-specific hooks
2. `~/.civilclaw/hooks/` — global hooks
3. Files named by convention: `before-prompt.js`, `after-tool-call.js`, etc.

#### Execution

```typescript
class HookRunner {
  private hooks: Map<HookEvent, HookDefinition[]>;

  load(workspaceDir: string, agentDir: string): void;
  async run(event: HookEvent, context: HookContext): Promise<HookResult>;
}
```

- **JS hooks:** `import()` the module, call its default export with context
- **Shell hooks:** Execute via `child_process.execFile`, pass context as JSON on stdin, read result from stdout
- Hooks run sequentially in priority order
- If any hook throws, log a warning and continue (hooks should never break the agent)

#### Example: log all bash commands

```javascript
// .civilclaw/hooks/log-bash.js
import fs from "node:fs";

export default async (context) => {
  if (context.event === "after_tool_call" && context.toolName === "bash") {
    const line = `${new Date().toISOString()} ${context.toolArgs.command}\n`;
    fs.appendFileSync("agent-commands.log", line);
  }
  return {};
};
```

---

## 9. Memory System

### What it does

Vector-based persistent memory that lets the agent remember information across sessions — past conversations, user preferences, project decisions, debugging insights. The agent can search memories via a tool, and new conversations are automatically indexed.

### Why it matters

Without memory, every civilclaw session starts from zero. The agent can't remember user preferences, past decisions, project context from previous conversations, or learn from mistakes. This is the single biggest gap between civilclaw and the full openclaw. It's what turns a stateless tool into a persistent assistant that knows you and your project.

### New dependencies

- `better-sqlite3` — SQLite database
- `sqlite-vec` — Vector similarity search extension for SQLite
- OpenAI embeddings API (reuse existing `OPENAI_API_KEY`)

### New files

- `src/memory/store.ts` (~200 lines) — SQLite + vector storage layer
- `src/memory/embeddings.ts` (~80 lines) — Embedding provider (OpenAI initially)
- `src/memory/indexer.ts` (~120 lines) — Index conversations into memory
- `src/memory/search.ts` (~150 lines) — Hybrid search (vector + keyword)
- `src/memory/tool.ts` (~80 lines) — Memory search tool for the agent

### Files to modify

- `src/entry.ts` — Initialize memory, register tool, index after each interaction
- `src/system-prompt.ts` — Add memory recall section to prompt

### Implementation

#### Storage schema

```sql
-- Memory chunks
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source TEXT NOT NULL,             -- "conversation", "manual", "file"
  session_id TEXT,
  created_at REAL NOT NULL,         -- Unix timestamp
  metadata TEXT                     -- JSON metadata (tags, etc.)
);

-- Vector embeddings (via sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[1536]            -- OpenAI text-embedding-3-small
);

-- Full-text search index (BM25)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id'
);
```

**Storage location:** `~/.civilclaw/memory/memory.db`

#### Embedding provider

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

class OpenAIEmbeddings implements EmbeddingProvider {
  model = "text-embedding-3-small";
  dimensions = 1536;

  async embed(texts: string[]): Promise<number[][]> {
    // Call OpenAI embeddings API
    // Batch up to 100 texts per request
    // Cache results for identical texts (5-min TTL)
  }
}
```

#### Conversation indexing

After each `session.prompt()` completes:

```typescript
async function indexConversation(params: {
  messages: AgentMessage[];
  sessionId: string;
  store: MemoryStore;
  embeddings: EmbeddingProvider;
}): Promise<void> {
  // 1. Extract meaningful content from user + assistant messages
  // 2. Chunk into ~500 token segments with overlap
  // 3. Skip tool calls, tool results (too noisy)
  // 4. Generate embeddings for new chunks
  // 5. Store chunks + embeddings + FTS entries
  // 6. Track which messages have been indexed (avoid re-indexing)
}
```

#### Hybrid search

```typescript
interface SearchResult {
  content: string;
  score: number;         // 0–1 combined score
  source: string;
  sessionId?: string;
  createdAt: number;
}

async function searchMemory(params: {
  query: string;
  store: MemoryStore;
  embeddings: EmbeddingProvider;
  maxResults?: number;   // default: 5
  minScore?: number;     // default: 0.3
}): Promise<SearchResult[]> {
  // 1. Generate query embedding
  // 2. Vector search: top-20 by cosine similarity (sqlite-vec)
  // 3. Keyword search: top-20 by BM25 (FTS5)
  // 4. Merge with Reciprocal Rank Fusion (RRF)
  // 5. Apply temporal decay: recent memories score higher
  // 6. Apply MMR deduplication: remove near-duplicate results
  // 7. Return top maxResults
}
```

#### Temporal decay

Recent memories are weighted higher:

```typescript
function temporalDecay(createdAt: number, now: number): number {
  const daysSince = (now - createdAt) / (1000 * 60 * 60 * 24);
  return Math.exp(-0.01 * daysSince);  // half-life ~70 days
}
```

#### Memory tool

```typescript
// Tool: "memory_search"
// Parameters: { query: string, maxResults?: number }
// Returns: Array of { content, score, source, age }
```

#### System prompt addition

```
## Memory
You have access to a persistent memory system across sessions.

### Automatic Memory
Conversations are automatically indexed. Past context is available via memory_search.

### Using Memory
- Use memory_search when you need to recall past conversations, decisions, or context
- Results include relevance scores — higher is more relevant
- Recent memories rank higher (temporal weighting)

### What Gets Remembered
- User preferences and working style
- Project decisions and architectural choices
- Debugging insights and solutions
- Important file paths and patterns
```

#### Integration in entry.ts

1. Initialize `MemoryStore` at startup (open/create SQLite DB)
2. Initialize `EmbeddingProvider` (requires `OPENAI_API_KEY` — skip gracefully if unavailable)
3. Register `memory_search` as a custom tool
4. After each `session.prompt()`, call `indexConversation()` in background (non-blocking)
5. Add `/memory` command — show stats (total chunks, DB size)
6. Add `/forget` command — clear all memory

---

## Cross-Feature Dependencies

```
Feature 1 (Thinking) ──→ standalone
Feature 2 (Usage)    ──→ standalone
Feature 3 (Loops)    ──→ standalone
Feature 4 (Compact)  ──→ standalone (SDK built-in)
Feature 5 (Skills)   ──→ standalone (SDK built-in)
Feature 6 (Fallback) ──→ benefits from #2 (track which model was used for cost)
Feature 7 (Subagent) ──→ standalone (benefits from #3 for child loop detection)
Feature 8 (Hooks)    ──→ standalone (can wrap #3, #6, #7)
Feature 9 (Memory)   ──→ benefits from #4 (index before compaction discards messages)
```

All features can be implemented independently. The dependencies listed are "nice to have" synergies, not hard requirements.

---

## Verification

For each feature, verify by:

1. `pnpm build` — TypeScript compiles without errors
2. `pnpm dev` — Run the agent interactively
3. Feature-specific tests:

| Feature | How to test |
|---------|-------------|
| Thinking | `/think high` → `/think off` → verify model parameter changes |
| Usage | Check token/cost display after each response |
| Loop detection | Ask agent to retry a failing command repeatedly |
| Compaction | Have a long conversation, verify auto-compaction triggers |
| Skills | Drop a `SKILL.md` in workspace, check `/skills` |
| Fallback | Set primary to invalid key, verify switch |
| Subagents | Ask "research X while implementing Y" |
| Hooks | Create `.civilclaw/hooks/before-prompt.js`, verify behavior |
| Memory | Chat → `/new` → search for previous context via agent |
