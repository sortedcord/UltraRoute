import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ErrorPrimitive,
  AuiIf,
} from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/ai-sdk";
import {
  ArrowUpIcon, ClipboardIcon, ThumbsUp, ThumbsDown, PanelLeft, ArrowUpRight,
  Plus, Mic, AudioWaveform, MessageSquare,
} from "lucide-react";
import type { ClaudeModelCatalog } from "../providers/claude/models.ts";
import type { GeminiModelCatalog } from "../providers/gemini/models.ts";
import {
  ClaudeSettings, Sidebar, ModelDropdown, ModelCatalogContext,
  type ModelOption, type ModelDiscovery, type SavedThread,
} from "./panels.tsx";
import workspaceStyles from "./app.css";
import panelStyles from "./panels.css";


const OTHER_MODELS: ModelOption[] = [
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    effort: "Standard",
    provider: "google",
  },
  {
    id: "gpt-5-6",
    name: "ChatGPT 5.6 Instant",
    effort: "Instant",
    provider: "chatgpt-web",
  },
  {
    id: "gpt-5-6-thinking",
    name: "ChatGPT 5.6 Thinking",
    effort: "Extended",
    provider: "chatgpt-web",
  },
];

function ClaudeThread({ selectedModel, onSelectModel, isSidebarOpen, onToggleSidebar }: {
  selectedModel: string;
  onSelectModel: (id: string) => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <ThreadPrimitive.Root className="pf-thread">
      <header className="pf-topbar">
        <button type="button" className={`pf-icon-button pf-sidebar-toggle ${isSidebarOpen ? "pf-desktop-hidden" : ""}`} onClick={onToggleSidebar} title={isSidebarOpen ? "Close sidebar" : "Open sidebar"} aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"} aria-expanded={isSidebarOpen}>
          <PanelLeft size={18} />
        </button>
        <div className="pf-topbar-title"><span className="pf-wordmark">ULTRAROUTE</span><span className="pf-topbar-divider" /><span className="pf-label">CHAT WORKSPACE</span></div>
        <div className="pf-session-badge"><span className="pf-status-dot" />FREE SESSION</div>
      </header>

      <AuiIf condition={(s) => s.thread.isEmpty}>
        <div className="pf-welcome-scroll">
          <div className="pf-welcome">
            <div className="pf-composer-heading"><h2>What’s on your mind?</h2></div>
            <ClaudeComposer selectedModel={selectedModel} onSelectModel={onSelectModel} />
          </div>
        </div>
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport className="pf-transcript">
          <div className="pf-messages">
            <ThreadPrimitive.Messages components={{
              UserMessage: () => (
                <MessagePrimitive.Root className="pf-user-message">
                  <span className="pf-message-label">YOU</span>
                  <div className="pf-user-content"><MessagePrimitive.Parts /></div>
                </MessagePrimitive.Root>
              ),
              AssistantMessage: () => (
                <MessagePrimitive.Root className="pf-assistant-message">
                  <span className="pf-message-label"><span className="pf-mini-prism" />ULTRAROUTE</span>
                  <div className="pf-assistant-content"><MessagePrimitive.Parts /></div>
                  <MessagePrimitive.Error><ErrorPrimitive.Root role="alert" className="pf-error"><ErrorPrimitive.Message /></ErrorPrimitive.Root></MessagePrimitive.Error>
                  <div className="pf-message-actions">
                    <button type="button" className="pf-icon-button" aria-label="Copy response" title="Copy response"><ClipboardIcon size={15} /></button>
                    <button type="button" className="pf-icon-button" aria-label="Good response" title="Good response"><ThumbsUp size={15} /></button>
                    <button type="button" className="pf-icon-button" aria-label="Bad response" title="Bad response"><ThumbsDown size={15} /></button>
                  </div>
                </MessagePrimitive.Root>
              ),
            }} />
            <AuiIf condition={(s) => s.thread.isRunning}><div role="status" className="pf-running"><span className="pf-status-dot" />Working on your response…</div></AuiIf>
          </div>
          <ThreadPrimitive.ViewportFooter className="pf-transcript-footer">
            <ClaudeComposer selectedModel={selectedModel} onSelectModel={onSelectModel} />
            <p className="pf-composer-note">A fresh perspective, not the final word. Check important details.</p>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </AuiIf>
    </ThreadPrimitive.Root>
  );
}

function ClaudeComposer({ selectedModel, onSelectModel }: {
  selectedModel: string;
  onSelectModel: (id: string) => void;
}) {
  return (
    <ComposerPrimitive.Root className="pf-composer">
      <ComposerPrimitive.Input className="pf-composer-input" aria-label="Message" placeholder="Ask a question, explore an idea, or make something…" />
      <div className="pf-composer-toolbar">
        <div className="pf-composer-tools">
          <button type="button" className="pf-icon-button" title="Attach file" aria-label="Attach file"><Plus size={18} /></button>
          <div className="pf-mode-tabs"><span className="pf-mode-active"><MessageSquare size={13} />Chat</span><span>Cowork</span></div>
        </div>
        <div className="pf-composer-controls">
          <ModelDropdown selected={selectedModel} onSelect={onSelectModel} />
          <button type="button" className="pf-icon-button pf-voice-button" aria-label="Voice input" title="Voice input"><Mic size={17} /></button>
          <button type="button" className="pf-icon-button pf-voice-button" aria-label="Voice mode" title="Voice mode"><AudioWaveform size={17} /></button>
          <ComposerPrimitive.Send className="pf-send" aria-label="Send message" title="Send message"><ArrowUpIcon size={18} /></ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState("gemini-3.5-flash-lite");
  const [reasoningByModel, setReasoningByModel] = useState<Record<string, string>>({});
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 860);
  const [threads, setThreads] = useState<SavedThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [chatKey, setChatKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [claudeDiscovery, setClaudeDiscovery] = useState<ModelDiscovery>({
    models: [],
    loading: true,
    error: null,
  });
  const [geminiDiscovery, setGeminiDiscovery] = useState<ModelDiscovery>({
    models: [],
    loading: true,
    error: null,
  });
  const models = [
    ...OTHER_MODELS,
    ...claudeDiscovery.models,
    ...geminiDiscovery.models,
  ];

  useEffect(() => {
    const abort = new AbortController();
    async function loadClaudeModels() {
      try {
        const response = await fetch("/api/providers/claude-web/models", {
          signal: abort.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Claude model discovery failed");
        const catalog = data as ClaudeModelCatalog;
        const discovered = catalog.models.map((model): ModelOption => ({
          id: model.id,
          name: model.name,
          provider: "claude-web",
          disabled: model.disabled,
          availability: model.disabled
            ? `${model.badge ?? model.requiredPlan ?? "Unavailable"} — ${model.disabledReason === "upgrade_required" ? "Upgrade required" : "Unavailable"}`
            : model.section === "overflow"
              ? "Available · More models"
              : "Available",
        }));
        if (!abort.signal.aborted)
          setClaudeDiscovery({ models: discovered, loading: false, error: null });
      } catch (error) {
        if (!abort.signal.aborted)
          setClaudeDiscovery((previous) => ({
            ...previous,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Claude model discovery failed",
          }));
      }
    }
    async function loadGeminiModels() {
      try {
        const response = await fetch("/api/providers/gemini-web/models", {
          signal: abort.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Gemini Web model discovery failed");
        const catalog = data as GeminiModelCatalog;
        const discovered = catalog.models.map((model): ModelOption => ({
          id: model.id,
          name: model.name,
          provider: "gemini-web",
          disabled: model.disabled,
          availability: model.availability,
        }));
        if (!abort.signal.aborted)
          setGeminiDiscovery({ models: discovered, loading: false, error: null });
      } catch (error) {
        if (!abort.signal.aborted)
          setGeminiDiscovery((previous) => ({
            ...previous,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Gemini Web model discovery failed",
          }));
      }
    }
    void loadClaudeModels();
    void loadGeminiModels();
    return () => abort.abort();
  }, []);

  const currentProvider = models.find((m) => m.id === selectedModel)?.provider;
  const runtime = useChatRuntime({
    id: `thread-${activeThreadId}-${chatKey}`,
    onError: (error) => {
      // HTTP failures may carry a JSON error body; show its safe public message.
      let message =
        error.message || "The chat request failed. Please try again.";
      try {
        const parsed = JSON.parse(message) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {
      }
      setRuntimeError(message);
    },
    onFinish: ({ isError }) => {
      if (!isError) setRuntimeError(null);
    },
    transport: new AssistantChatTransport({
      api: "/api/chat",
      body: {
        model: selectedModel,
        provider: currentProvider,
      },
    }),
  });

  const handleNewThread = () => {
    setRuntimeError(null);
    const newId = `thread-${Date.now()}`;
    const newT: SavedThread = {
      id: newId,
      title: "Untitled",
      createdAt: Date.now(),
    };
    setThreads([newT, ...threads]);
    setActiveThreadId(newId);
    setChatKey((k) => k + 1);
  };

  const handleDeleteThread = (id: string) => {
    const updated = threads.filter((t) => t.id !== id);
    setThreads(updated);
    if (activeThreadId === id && updated.length > 0) {
      setActiveThreadId(updated[0].id);
      setChatKey((k) => k + 1);
    }
  };

  return (
    <ModelCatalogContext.Provider
      value={{
        models,
        reasoningByModel,
        onReasoningChange: (model, value) => setReasoningByModel(previous => ({ ...previous, [model]: value })),
        discoveries: [
          {
            name: "Claude",
            loading: claudeDiscovery.loading,
            error: claudeDiscovery.error,
          },
          {
            name: "Gemini Web",
            loading: geminiDiscovery.loading,
            error: geminiDiscovery.error,
          },
        ],
      }}
    >
      <style>{workspaceStyles + panelStyles}</style>
      <div className="pf-stage">
      <div className="pf-canvas">
        {isSidebarOpen && <button type="button" className="pf-drawer-backdrop" aria-label="Close navigation" onClick={() => setIsSidebarOpen(false)} />}
        <Sidebar
          onSettings={() => setSettingsOpen(true)}
          isOpen={isSidebarOpen}
          onToggle={() => setIsSidebarOpen(false)}
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={(id) => {
            setActiveThreadId(id);
            setChatKey((k) => k + 1);
            if (window.innerWidth < 860) setIsSidebarOpen(false);
          }}
          onNewThread={() => {
            handleNewThread();
            if (window.innerWidth < 860) setIsSidebarOpen(false);
          }}
          onDeleteThread={handleDeleteThread}
        />
        <main className="pf-main">
          <AssistantRuntimeProvider runtime={runtime}>
            {runtimeError && (
              <div role="alert" className="pf-runtime-error">
                {runtimeError}
              </div>
            )}
            <ClaudeThread
              selectedModel={selectedModel}
              onSelectModel={(model) => {
                setRuntimeError(null);
                setSelectedModel(model);
              }}
              isSidebarOpen={isSidebarOpen}
              onToggleSidebar={() => setIsSidebarOpen((open) => !open)}
            />
          </AssistantRuntimeProvider>
        </main>
      </div>
      </div>
      {settingsOpen && <ClaudeSettings onClose={() => setSettingsOpen(false)} />}
    </ModelCatalogContext.Provider>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
