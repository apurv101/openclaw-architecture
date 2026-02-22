import { useState, useEffect } from "react";
import Chat from "./Chat";
import { newSession, getStatus } from "./api";

export default function App() {
  const [modelName, setModelName] = useState("");

  useEffect(() => {
    getStatus()
      .then((s) => setModelName(`${s.provider}/${s.model}`))
      .catch(() => setModelName("unknown"));
  }, []);

  const handleNewSession = async () => {
    await newSession();
    window.location.reload();
  };

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-gray-900">civilclaw</h1>
          {modelName && (
            <span className="text-xs text-gray-400 font-mono">{modelName}</span>
          )}
        </div>
        <button
          onClick={handleNewSession}
          className="text-xs text-gray-500 hover:text-gray-900 px-3 py-1 rounded-lg hover:bg-gray-100 transition-colors"
        >
          New session
        </button>
      </header>

      {/* Chat */}
      <main className="flex-1 overflow-hidden">
        <Chat />
      </main>
    </div>
  );
}
