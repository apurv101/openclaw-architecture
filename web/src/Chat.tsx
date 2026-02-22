import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import { streamChat, type ChatEvent } from "./api";

interface Message {
  role: "user" | "assistant";
  content: string;
  tools?: { id: string; name: string; done: boolean; isError?: boolean }[];
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    setIsStreaming(true);

    // Add user message + empty assistant message
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", tools: [] },
    ]);

    const controller = streamChat(text, (event: ChatEvent) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = { ...updated[updated.length - 1]! };
        last.tools = [...(last.tools ?? [])];

        switch (event.type) {
          case "text_delta":
            last.content += event.delta;
            break;
          case "tool_start":
            last.tools.push({
              id: event.id,
              name: event.name,
              done: false,
            });
            break;
          case "tool_end":
            last.tools = last.tools.map((t) =>
              t.id === event.id
                ? { ...t, done: true, isError: event.isError }
                : t,
            );
            break;
          case "done":
            setIsStreaming(false);
            break;
          case "error":
            last.content += `\n\n**Error:** ${event.error}`;
            setIsStreaming(false);
            break;
        }

        updated[updated.length - 1] = last;
        return updated;
      });
    });

    abortRef.current = controller;
  }, [input, isStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-20">
            <p className="text-2xl font-semibold mb-2">civilclaw</p>
            <p className="text-sm">
              AEC intelligence. Ask about structural analysis, building codes,
              cost estimation, energy modeling, or anything else.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {/* Tool indicators */}
              {msg.tools && msg.tools.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {msg.tools.map((tool) => (
                    <span
                      key={tool.id}
                      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                        tool.isError
                          ? "bg-red-100 text-red-700"
                          : tool.done
                            ? "bg-green-100 text-green-700"
                            : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {!tool.done && (
                        <span className="inline-block w-2 h-2 rounded-full bg-current animate-pulse" />
                      )}
                      {tool.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Message content */}
              {msg.role === "assistant" ? (
                <div className="prose prose-sm max-w-none prose-gray">
                  <Markdown>{msg.content || (isStreaming && i === messages.length - 1 ? "..." : "")}</Markdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 px-4 py-3 bg-white">
        <div className="flex items-end gap-2 max-w-4xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask civilclaw..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={isStreaming}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="rounded-xl bg-blue-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isStreaming ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
