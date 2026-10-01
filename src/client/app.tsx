import React, { createContext, useContext, useEffect, useState } from "react";
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
  ArrowUpIcon,
  Sparkle,
  ClipboardIcon,
  ThumbsUp,
  ThumbsDown,
  CheckIcon,
  ChevronDownIcon,
  PanelLeftClose,
  PanelLeft,
  Plus,
  MessageSquare,
  Trash2,
  FolderOpen,
  LayoutGrid,
  Code2,
  SlidersHorizontal,
  Mic,
  AudioWaveform,
  Search,
} from "lucide-react";

import type { ClaudeModelCatalog } from "../providers/claude/models.ts";
import type { GeminiModelCatalog } from "../providers/gemini/models.ts";

interface ModelOption {
  id: string;
  name: string;
  effort?: string;
  provider: string;
  disabled?: boolean;
  availability?: string;
}

interface ModelDiscovery {
  models: ModelOption[];
  loading: boolean;
  error: string | null;
}

const ModelCatalogContext = createContext<{
  models: ModelOption[];
  discoveries: { name: string; loading: boolean; error: string | null }[];
}>({ models: [], discoveries: [] });

interface SavedThread {
  id: string;
  title: string;
  createdAt: number;
}

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

function ModelDropdown({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { models, discoveries } = useContext(ModelCatalogContext);
  const current = models.find((m) => m.id === selected) ?? models[0];

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "transparent",
          border: "none",
          padding: "4px 8px",
          fontSize: "0.85rem",
          color: "#4d4d4d",
          cursor: "pointer",
          borderRadius: "6px",
          fontWeight: 500,
        }}
      >
        <span style={{ color: "#111" }}>{current?.name ?? "Select model"}</span>
        <span style={{ color: "#777", fontSize: "0.8rem" }}>
          {current?.effort}
        </span>
        <ChevronDownIcon size={14} style={{ opacity: 0.6 }} />
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            right: 0,
            marginBottom: "8px",
            background: "#ffffff",
            border: "1px solid rgba(0, 0, 0, 0.12)",
            borderRadius: "12px",
            padding: "6px",
            minWidth: "220px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            maxHeight: "360px",
            overflowY: "auto",
            zIndex: 100,
          }}
        >
          {discoveries.map(({ name, loading, error }) => (
            <React.Fragment key={name}>
              {loading && (
                <div role="status" style={{ padding: "8px 12px" }}>
                  Loading {name} models…
                </div>
              )}
              {error && (
                <div role="alert" style={{ padding: "8px 12px", color: "#b42318" }}>
                  {name}: {error}
                </div>
              )}
            </React.Fragment>
          ))}
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={m.disabled}
              onClick={() => {
                onSelect(m.id);
                setOpen(false);
              }}
              style={{
                padding: "8px 12px",
                width: "100%",
                border: "none",
                textAlign: "left",
                opacity: m.disabled ? 0.6 : 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: "0.85rem",
                color: "#111",
                cursor: m.disabled ? "not-allowed" : "pointer",
                borderRadius: "6px",
                background:
                  m.id === selected ? "rgba(0,0,0,0.05)" : "transparent",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontWeight: 500 }}>{m.name}</span>
                <span style={{ fontSize: "0.75rem", color: "#666" }}>
                  {m.availability ??
                    (m.effort ? `${m.effort} reasoning` : "Available")}
                </span>
              </div>
              {m.id === selected && <CheckIcon size={14} color="#c96442" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({
  isOpen,
  onToggle,
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  isOpen: boolean;
  onToggle: () => void;
  threads: SavedThread[];
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
}) {
  if (!isOpen) return null;

  return (
    <aside
      style={{
        width: "250px",
        height: "100%",
        background: "rgb(250, 250, 248)", // Claude live light sidebar color
        borderRight: "1px solid rgba(0, 0, 0, 0.08)",
        display: "flex",
        flexDirection: "column",
        color: "#111",
        flexShrink: 0,
        fontSize: "0.88rem",
      }}
    >
      {/* Sidebar Header */}
      <div
        style={{
          padding: "14px 16px 10px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontFamily: "Charter, Georgia, serif",
            fontWeight: 700,
            fontSize: "1.25rem",
            color: "#111",
          }}
        >
          UltraRoute
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <button
            onClick={onToggle}
            title="Collapse sidebar"
            style={{
              background: "transparent",
              border: "none",
              color: "#666",
              cursor: "pointer",
              padding: "6px",
              borderRadius: "6px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
      </div>

      {/* Start New Chat Button */}
      <div style={{ padding: "0 12px 10px 12px" }}>
        <button
          onClick={onNewThread}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "rgba(0, 0, 0, 0.04)",
            border: "none",
            color: "#111",
            padding: "8px 12px",
            borderRadius: "8px",
            cursor: "pointer",
            fontSize: "0.9rem",
            fontWeight: 500,
          }}
        >
          <Plus size={16} color="#c96442" />
          <span>New</span>
        </button>
      </div>

      {/* Navigation section */}
      <div
        style={{
          padding: "0 12px 12px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          borderBottom: "1px solid rgba(0, 0, 0, 0.06)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 8px",
            borderRadius: "6px",
            color: "#444",
            cursor: "pointer",
          }}
        >
          <FolderOpen size={16} />
          <span>Projects</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 8px",
            borderRadius: "6px",
            color: "#444",
            cursor: "pointer",
          }}
        >
          <LayoutGrid size={16} />
          <span>Artifacts</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 8px",
            borderRadius: "6px",
            color: "#444",
            cursor: "pointer",
          }}
        >
          <Code2 size={16} />
          <span>Code</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 8px",
            borderRadius: "6px",
            color: "#444",
            cursor: "pointer",
          }}
        >
          <SlidersHorizontal size={16} />
          <span>Customize</span>
        </div>
      </div>

      {/* Chats List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
        <div
          style={{
            fontSize: "0.75rem",
            color: "#888",
            padding: "4px 8px",
            fontWeight: 600,
          }}
        >
          Chats and tasks
        </div>
        {threads.map((t) => {
          const isActive = t.id === activeThreadId;
          return (
            <div
              key={t.id}
              onClick={() => onSelectThread(t.id)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "7px 10px",
                borderRadius: "6px",
                cursor: "pointer",
                background: isActive ? "rgba(0, 0, 0, 0.06)" : "transparent",
                color: isActive ? "#111" : "#555",
                fontWeight: isActive ? 500 : 400,
                fontSize: "0.85rem",
                marginBottom: "2px",
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteThread(t.id);
                }}
                title="Delete chat"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#999",
                  cursor: "pointer",
                  padding: "2px",
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Profile Bar */}
      <div
        style={{
          padding: "12px 16px",
          borderTop: "1px solid rgba(0, 0, 0, 0.08)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
        }}
      >
        <div
          style={{
            width: "26px",
            height: "26px",
            borderRadius: "50%",
            background: "#e5e0d6",
            color: "#5b5950",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: "0.75rem",
          }}
        >
          AG
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 500, color: "#111" }}>
            UltraRoute User
          </div>
          <div style={{ fontSize: "0.75rem", color: "#888" }}>Free session</div>
        </div>
      </div>
    </aside>
  );
}

function ClaudeThread({
  selectedModel,
  onSelectModel,
  isSidebarOpen,
  onToggleSidebar,
}: {
  selectedModel: string;
  onSelectModel: (id: string) => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <ThreadPrimitive.Root
      style={{
        display: "flex",
        height: "100%",
        flexDirection: "column",
        background: "rgb(252, 252, 251)", // Claude live light background
        color: "#111",
        position: "relative",
      }}
    >
      {/* Top action header */}
      <div
        style={{
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {!isSidebarOpen && (
          <button
            onClick={onToggleSidebar}
            title="Open sidebar"
            style={{
              background: "transparent",
              border: "none",
              color: "#666",
              cursor: "pointer",
              padding: "6px",
              borderRadius: "6px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <PanelLeft size={18} />
          </button>
        )}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              fontSize: "0.8rem",
              color: "#666",
              background: "rgba(0,0,0,0.04)",
              padding: "3px 8px",
              borderRadius: "6px",
            }}
          >
            Free plan · <strong style={{ color: "#3b82f6" }}>UltraRoute</strong>
          </span>
        </div>
      </div>

      <AuiIf condition={(s) => s.thread.isEmpty}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 24px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "670px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "28px",
            }}
          >
            <p
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
                fontSize: "2.4rem",
                color: "#111",
                fontFamily: "Charter, Georgia, serif",
              }}
            >
              <Sparkle size={30} color="#c96442" fill="#c96442" />
              <span>You're here!</span>
            </p>
            <ClaudeComposer
              selectedModel={selectedModel}
              onSelectModel={onSelectModel}
            />
          </div>
        </div>
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            padding: "20px 16px 0 16px",
          }}
        >
          <div
            style={{
              maxWidth: "670px",
              width: "100%",
              margin: "0 auto",
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: "24px",
            }}
          >
            <ThreadPrimitive.Messages
              components={{
                UserMessage: () => (
                  <MessagePrimitive.Root
                    style={{
                      alignSelf: "flex-end",
                      maxWidth: "80%",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <div
                      style={{
                        background: "rgb(238, 235, 227)",
                        color: "#111",
                        padding: "12px 18px",
                        borderRadius: "18px",
                        fontSize: "0.95rem",
                        lineHeight: "1.6",
                        wordBreak: "break-word",
                      }}
                    >
                      <MessagePrimitive.Parts />
                    </div>
                  </MessagePrimitive.Root>
                ),
                AssistantMessage: () => (
                  <MessagePrimitive.Root
                    style={{
                      alignSelf: "flex-start",
                      width: "100%",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div
                      style={{
                        color: "#111",
                        fontSize: "1rem",
                        lineHeight: "1.75",
                        wordBreak: "break-word",
                      }}
                    >
                      <MessagePrimitive.Parts />
                    </div>
                    <MessagePrimitive.Error>
                      <ErrorPrimitive.Root
                        role="alert"
                        style={{ color: "#b42318", fontSize: "0.9rem" }}
                      >
                        <ErrorPrimitive.Message />
                      </ErrorPrimitive.Root>
                    </MessagePrimitive.Error>
                    <div style={{ display: "flex", gap: "6px", opacity: 0.7 }}>
                      <button
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#666",
                          cursor: "pointer",
                          padding: "4px",
                        }}
                      >
                        <ClipboardIcon size={15} />
                      </button>
                      <button
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#666",
                          cursor: "pointer",
                          padding: "4px",
                        }}
                      >
                        <ThumbsUp size={15} />
                      </button>
                      <button
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#666",
                          cursor: "pointer",
                          padding: "4px",
                        }}
                      >
                        <ThumbsDown size={15} />
                      </button>
                    </div>
                  </MessagePrimitive.Root>
                ),
              }}
            />
          </div>

          <ThreadPrimitive.ViewportFooter
            style={{
              position: "sticky",
              bottom: 0,
              width: "100%",
              maxWidth: "670px",
              margin: "0 auto",
              padding: "16px 0 12px 0",
              background:
                "linear-gradient(to top, rgb(252, 252, 251) 80%, transparent)",
            }}
          >
            <ClaudeComposer
              selectedModel={selectedModel}
              onSelectModel={onSelectModel}
            />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </AuiIf>
    </ThreadPrimitive.Root>
  );
}

function ClaudeComposer({
  selectedModel,
  onSelectModel,
}: {
  selectedModel: string;
  onSelectModel: (id: string) => void;
}) {
  return (
    <ComposerPrimitive.Root
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: "20px",
        border: "1px solid rgba(0, 0, 0, 0.12)",
        background: "rgb(255, 255, 255)", // White card surface
        padding: "16px 18px 12px 18px",
        gap: "12px",
        width: "100%",
        boxShadow: "0 4px 20px rgba(0, 0, 0, 0.06)",
      }}
    >
      <ComposerPrimitive.Input
        placeholder="How can I help you today?"
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          color: "#111",
          fontSize: "1rem",
          fontFamily: "inherit",
          outline: "none",
          resize: "none",
          height: 180,
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: "4px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            type="button"
            title="Attach file"
            style={{
              background: "transparent",
              border: "none",
              color: "#555",
              cursor: "pointer",
              padding: "4px 6px",
              borderRadius: "6px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Plus size={16} />
          </button>
          <div
            style={{
              display: "flex",
              background: "rgba(0, 0, 0, 0.05)",
              borderRadius: "8px",
              padding: "2px",
            }}
          >
            <span
              style={{
                fontSize: "0.8rem",
                padding: "3px 8px",
                borderRadius: "6px",
                background: "#fff",
                fontWeight: 600,
                color: "#111",
                boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
              }}
            >
              Chat
            </span>
            <span
              style={{ fontSize: "0.8rem", padding: "3px 8px", color: "#666" }}
            >
              Cowork
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ModelDropdown selected={selectedModel} onSelect={onSelectModel} />
          <button
            style={{
              background: "transparent",
              border: "none",
              color: "#666",
              cursor: "pointer",
              padding: "4px",
            }}
          >
            <Mic size={16} />
          </button>
          <button
            style={{
              background: "transparent",
              border: "none",
              color: "#666",
              cursor: "pointer",
              padding: "4px",
            }}
          >
            <AudioWaveform size={16} />
          </button>
          <ComposerPrimitive.Send
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "30px",
              height: "30px",
              borderRadius: "50%",
              background: "#c96442",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              marginLeft: "4px",
            }}
          >
            <ArrowUpIcon size={15} />
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function App() {
  const [selectedModel, setSelectedModel] = useState("gemini-3.5-flash-lite");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
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
        // Stream errors already contain a public message.
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
      <div
        style={{
          height: "100vh",
          display: "flex",
          overflow: "hidden",
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <Sidebar
          isOpen={isSidebarOpen}
          onToggle={() => setIsSidebarOpen(false)}
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={(id) => {
            setActiveThreadId(id);
            setChatKey((k) => k + 1);
          }}
          onNewThread={handleNewThread}
          onDeleteThread={handleDeleteThread}
        />
        <main style={{ flex: 1, overflow: "hidden" }}>
          <AssistantRuntimeProvider runtime={runtime}>
            {runtimeError && (
              <div
                role="alert"
                style={{
                  color: "#b42318",
                  background: "#fff4f2",
                  padding: "12px 20px",
                }}
              >
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
              onToggleSidebar={() => setIsSidebarOpen(true)}
            />
          </AssistantRuntimeProvider>
        </main>
      </div>
    </ModelCatalogContext.Provider>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
