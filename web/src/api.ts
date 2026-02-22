export interface FileMeta {
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
  source: "upload" | "generated";
}

export type ChatEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; isError: boolean }
  | { type: "files_updated"; files: FileMeta[] }
  | { type: "done" }
  | { type: "error"; error: string };

/**
 * Stream a chat message via SSE. Calls onEvent for each server-sent event.
 * Returns an AbortController to cancel the stream.
 */
export function streamChat(
  message: string,
  onEvent: (event: ChatEvent) => void,
  files?: FileMeta[],
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          files: files?.map((f) => ({ filename: f.filename })) ?? [],
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        onEvent({ type: "error", error: `HTTP ${res.status}` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" && currentEvent && currentData) {
            try {
              const parsed = JSON.parse(currentData);
              onEvent({ type: currentEvent, ...parsed } as ChatEvent);
            } catch {
              // Skip malformed events
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        onEvent({ type: "error", error: err.message });
      }
    }
  })();

  return controller;
}

export async function newSession(): Promise<string> {
  const res = await fetch("/api/session/new", { method: "POST" });
  const data = await res.json();
  return data.sessionId;
}

export async function getStatus(): Promise<{
  provider: string;
  model: string;
  sessionId: string;
  tools: string[];
  workspaceDir: string;
}> {
  const res = await fetch("/api/status");
  return res.json();
}

// ─── File API ─────────────────────────────────────────────────────────────

/** Upload files to the current session workspace */
export async function uploadFiles(files: File[]): Promise<FileMeta[]> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  const res = await fetch("/api/files/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  return data.files;
}

/** List files in the current session workspace */
export async function listFiles(): Promise<FileMeta[]> {
  const res = await fetch("/api/files");
  if (!res.ok) throw new Error(`List files failed: ${res.status}`);
  const data = await res.json();
  return data.files;
}

/** Get download URL for a file */
export function fileUrl(filename: string): string {
  return `/api/files/${encodeURIComponent(filename)}`;
}

/** Delete a file */
export async function deleteFile(filename: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}
