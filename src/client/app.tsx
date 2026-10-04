import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
  ErrorPrimitive,
  AuiIf,
  AttachmentPrimitive,
  useAuiState,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/ai-sdk";
import {
  ArrowUpIcon,
  ClipboardIcon,
  Check,
  ThumbsUp,
  ThumbsDown,
  PanelLeft,
  ArrowUpRight,
  Plus,
  Mic,
  AudioWaveform,
  Globe,
  Paperclip,
  Camera,
  FolderPlus,
  GitBranch,
  Code2,
  Blocks,
  Puzzle,
  Search,
  ImagePlus,
  Video,
  Music2,
  PanelsTopLeft,
  BrainCircuit,
  GraduationCap,
  Sparkles,
  MoreHorizontal,
  Palette,
  HardDriveUpload,
  BookOpenCheck,
  ChevronRight,
  X,
} from "lucide-react";
import type { ClaudeModelCatalog } from "../providers/claude/models.ts";
import type { GeminiModelCatalog } from "../providers/gemini/models.ts";
import type { ChatGptModelCatalog } from "../providers/chatgpt/models.ts";
import {
  ClaudeSettings,
  Sidebar,
  ModelDropdown,
  ModelCatalogContext,
  type ModelOption,
  type ModelDiscovery,
  type SavedThread,
} from "./panels.tsx";
import workspaceStyles from "./app.css";
import panelStyles from "./panels.css";
import { CitationText, useInlineSourceIds } from "./citationText.tsx";
import { ResponsiveMenu, useMobileViewport } from "./mobileDrawer.tsx";
import { createAttachmentAdapter } from "./attachments.ts";
import { ResponsiveSidebar } from "./mobileNavigation.tsx";

type PlusMenuCategory = "uploads" | "tools" | null;

const unavailableTitle = "This action is not available in UltraRoute yet";

function ComposerPlusMenu() {
  const [open, setOpen] = useState(false);
  const mobile = useMobileViewport();
  const [expanded, setExpanded] = useState<PlusMenuCategory>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [opensUp, setOpensUp] = useState(true);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || mobile) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !submenuRef.current?.contains(event.target)
      ) {
        setOpen(false);
        setExpanded(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        setExpanded(null);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, mobile]);

  useLayoutEffect(() => {
    if (!open || mobile) return;
    const trigger = triggerRef.current;
    const menu = menuPanelRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const availableAbove = rect.top - 8;
    const availableBelow = window.innerHeight - rect.bottom - 8;
    setOpensUp(
      availableAbove >= menu.scrollHeight || availableAbove >= availableBelow,
    );
  }, [open, mobile]);

  useEffect(() => {
    if (!expanded || mobile) {
      setSubmenuPosition(null);
      return;
    }
    const trigger = menuRef.current?.querySelector<HTMLButtonElement>(
      `[data-plus-group="${expanded}"]`,
    );
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 260;
    const menuHeight = expanded === "uploads" ? 184 : 104;
    const gutter = 12;
    const left = Math.min(
      window.innerWidth - menuWidth - gutter,
      rect.right + 8,
    );
    const top = Math.max(
      gutter,
      Math.min(rect.top, window.innerHeight - menuHeight - gutter),
    );
    setSubmenuPosition({ left, top });
  }, [expanded, open, mobile]);

  const expandedOptions =
    expanded === "uploads" ? (
      <>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <ImagePlus size={16} aria-hidden="true" />
          <span>Google Photos</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <GitBranch size={16} aria-hidden="true" />
          <span>Add from GitHub</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <HardDriveUpload size={16} aria-hidden="true" />
          <span>Add from Drive</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <Sparkles size={16} aria-hidden="true" />
          <span>Avatar</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <Code2 size={16} aria-hidden="true" />
          <span>Import code</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <BookOpenCheck size={16} aria-hidden="true" />
          <span>Notebooks</span>
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <PanelsTopLeft size={16} aria-hidden="true" />
          <span>Canvas</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="pf-plus-item"
          disabled
          title={unavailableTitle}
        >
          <Sparkles size={16} aria-hidden="true" />
          <span>
            Personal Intelligence <small>Labs</small>
          </span>
        </button>
      </>
    );
  return (
    <div ref={menuRef} className="pf-plus-menu-wrap">
      <ResponsiveMenu
        open={open}
        onClose={() => {
          setOpen(false);
          setExpanded(null);
        }}
        label="Add to chat"
      >
        <div
          ref={menuPanelRef}
          className={`pf-plus-menu ${opensUp ? "pf-plus-menu-up" : "pf-plus-menu-down"}`}
          role="menu"
          aria-label="Add to chat"
        >
          <div className="pf-plus-sections">
            <section className="pf-plus-section pf-plus-section-add">
              <div className="pf-plus-group-label">Add to chat</div>
              <ComposerPrimitive.AddAttachment asChild>
                <button
                  type="button"
                  role="menuitem"
                  className="pf-plus-item"
                  onClick={() => setOpen(false)}
                >
                  <Paperclip size={17} aria-hidden="true" />
                  <span>Add files or photos</span>
                  <kbd>Ctrl+U</kbd>
                </button>
              </ComposerPrimitive.AddAttachment>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item"
                disabled
                title={unavailableTitle}
              >
                <Camera size={17} aria-hidden="true" />
                <span>Take a screenshot</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item pf-plus-expand"
                data-plus-group="uploads"
                aria-expanded={expanded === "uploads"}
                onMouseEnter={() => {
                  if (!mobile) setExpanded("uploads");
                }}
                onFocus={() => {
                  if (!mobile) setExpanded("uploads");
                }}
                onClick={() =>
                  setExpanded((current) =>
                    mobile && current === "uploads" ? null : "uploads",
                  )
                }
              >
                <MoreHorizontal size={17} aria-hidden="true" />
                <span>More uploads</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
              {mobile && expanded === "uploads" && (
                <div
                  className="pf-plus-inline-options"
                  role="group"
                  aria-label="More uploads"
                >
                  {expandedOptions}
                </div>
              )}
            </section>
            <section className="pf-plus-section pf-plus-section-create">
              <div className="pf-plus-group-label">Create and research</div>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item"
                disabled
                title={unavailableTitle}
              >
                <Search size={17} aria-hidden="true" />
                <span>Web search</span>
              </button>
              <div
                className="pf-plus-create-pills"
                role="group"
                aria-label="Create"
              >
                <button
                  type="button"
                  className="pf-plus-pill"
                  disabled
                  title={unavailableTitle}
                >
                  <ImagePlus size={15} aria-hidden="true" />
                  <span>Create image</span>
                </button>
                <button
                  type="button"
                  className="pf-plus-pill"
                  disabled
                  title={unavailableTitle}
                >
                  <Video size={15} aria-hidden="true" />
                  <span>Create video</span>
                </button>
                <button
                  type="button"
                  className="pf-plus-pill"
                  disabled
                  title={unavailableTitle}
                >
                  <Music2 size={15} aria-hidden="true" />
                  <span>Create music</span>
                </button>
              </div>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item"
                disabled
                title={unavailableTitle}
              >
                <BrainCircuit size={17} aria-hidden="true" />
                <span>Deep research</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item pf-plus-expand"
                data-plus-group="tools"
                aria-expanded={expanded === "tools"}
                onMouseEnter={() => {
                  if (!mobile) setExpanded("tools");
                }}
                onFocus={() => {
                  if (!mobile) setExpanded("tools");
                }}
                onClick={() =>
                  setExpanded((current) =>
                    mobile && current === "tools" ? null : "tools",
                  )
                }
              >
                <MoreHorizontal size={17} aria-hidden="true" />
                <span>More tools</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
              {mobile && expanded === "tools" && (
                <div
                  className="pf-plus-inline-options"
                  role="group"
                  aria-label="More tools"
                >
                  {expandedOptions}
                </div>
              )}
            </section>
            <section className="pf-plus-section pf-plus-section-workspace">
              <div className="pf-plus-group-label">Workspace</div>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item"
                disabled
                title={unavailableTitle}
              >
                <PanelsTopLeft size={17} aria-hidden="true" />
                <span>Skills</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item"
                disabled
                title={unavailableTitle}
              >
                <Blocks size={17} aria-hidden="true" />
                <span>Add connector</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="menuitem"
                className="pf-plus-item"
                disabled
                title={unavailableTitle}
              >
                <Palette size={17} aria-hidden="true" />
                <span>Design system</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </section>
          </div>
        </div>
      </ResponsiveMenu>
      {open &&
        !mobile &&
        expanded &&
        submenuPosition &&
        createPortal(
          <div
            ref={submenuRef}
            className="pf-plus-flyout"
            style={{ left: submenuPosition.left, top: submenuPosition.top }}
            role="group"
            aria-label={expanded === "uploads" ? "More uploads" : "More tools"}
          >
            {expandedOptions}
          </div>,
          document.body,
        )}
      <button
        ref={triggerRef}
        type="button"
        className={`pf-icon-button${open ? " pf-plus-trigger-open" : ""}`}
        aria-label={open ? "Close add menu" : "Open add menu"}
        aria-haspopup={mobile ? "dialog" : "menu"}
        aria-expanded={open}
        title={open ? "Close add menu" : "Add to chat"}
        onClick={() => {
          setOpen((current) => !current);
          setExpanded(null);
        }}
      >
        {open ? (
          <X size={18} aria-hidden="true" />
        ) : (
          <Plus size={18} aria-hidden="true" />
        )}
      </button>
    </div>
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
    <ThreadPrimitive.Root className="pf-thread">
      <header className="pf-topbar">
        <button
          type="button"
          className={`pf-icon-button pf-sidebar-toggle ${isSidebarOpen ? "pf-desktop-hidden" : ""}`}
          onClick={onToggleSidebar}
          title={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
          aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
          aria-expanded={isSidebarOpen}
        >
          <PanelLeft size={18} />
        </button>
        <div className="pf-topbar-title">
          <span className="pf-wordmark">ULTRAROUTE</span>
          <span className="pf-topbar-divider" />
          <span className="pf-label">CHAT WORKSPACE</span>
        </div>
        <div className="pf-session-badge">
          <span className="pf-status-dot" />
          FREE SESSION
        </div>
      </header>

      <AuiIf condition={(s) => s.thread.isEmpty}>
        <div className="pf-welcome-scroll">
          <div className="pf-welcome">
            <div className="pf-composer-heading">
              <h2>What’s on your mind?</h2>
            </div>
            <ClaudeComposer
              selectedModel={selectedModel}
              onSelectModel={onSelectModel}
            />
          </div>
        </div>
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport className="pf-transcript">
          <div className="pf-messages">
            <ThreadPrimitive.Messages
              components={{
                UserMessage: () => (
                  <MessagePrimitive.Root className="pf-user-message">
                    <span className="pf-message-label">YOU</span>
                    <div className="pf-user-content">
                      <MessagePrimitive.Parts />
                    </div>
                    <MessagePrimitive.Attachments
                      components={{ Attachment: MessageAttachment }}
                    />
                  </MessagePrimitive.Root>
                ),
                AssistantMessage: () => (
                  <MessagePrimitive.Root className="pf-assistant-message">
                    <span className="pf-message-label">
                      <span className="pf-mini-prism" />
                      ULTRAROUTE
                    </span>
                    <div className="pf-assistant-content">
                      <MessagePrimitive.Parts
                        components={{
                          Text: CitationText,
                          Source: (part: {
                            id: string;
                            url?: string;
                            title?: string;
                            providerMetadata?: Record<string, unknown>;
                          }) => {
                            const inlineSourceIds = useInlineSourceIds();
                            if (inlineSourceIds.has(part.id)) return null;
                            if (!part.url) return null;
                            const geminiMeta = part.providerMetadata?.gemini as
                              | {
                                  citationNumber?: number;
                                  favicon?: string;
                                  snippet?: string;
                                }
                              | undefined;
                            let displayTitle = part.title;
                            if (!displayTitle) {
                              try {
                                displayTitle = new URL(
                                  part.url,
                                ).hostname.replace(/^www\./, "");
                              } catch {
                                displayTitle = part.url;
                              }
                            }
                            return (
                              <a
                                className="pf-source-chip"
                                href={part.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={
                                  geminiMeta?.snippet || part.title || part.url
                                }
                              >
                                {geminiMeta?.favicon ? (
                                  <img
                                    className="pf-source-favicon"
                                    src={geminiMeta.favicon}
                                    alt=""
                                    width={14}
                                    height={14}
                                  />
                                ) : (
                                  <Globe size={13} className="pf-source-icon" />
                                )}
                                <span className="pf-source-title">
                                  {displayTitle}
                                </span>
                                {geminiMeta?.citationNumber ? (
                                  <span className="pf-source-number">
                                    [{geminiMeta.citationNumber}]
                                  </span>
                                ) : null}
                              </a>
                            );
                          },
                        }}
                      />
                    </div>
                    <MessagePrimitive.Error>
                      <ErrorPrimitive.Root role="alert" className="pf-error">
                        <ErrorPrimitive.Message />
                      </ErrorPrimitive.Root>
                    </MessagePrimitive.Error>
                    <MessagePrimitive.If hasContent={true}>
                      <div className="pf-message-actions">
                        <ActionBarPrimitive.Copy asChild>
                          <button
                            type="button"
                            className="pf-icon-button pf-copy-button"
                            aria-label="Copy response"
                            title="Copy response"
                          >
                            <MessagePrimitive.If copied={false}>
                              <ClipboardIcon size={15} />
                            </MessagePrimitive.If>
                            <MessagePrimitive.If copied={true}>
                              <Check size={15} color="var(--lime)" />
                            </MessagePrimitive.If>
                          </button>
                        </ActionBarPrimitive.Copy>
                        <button
                          type="button"
                          className="pf-icon-button"
                          aria-label="Good response"
                          title="Good response"
                        >
                          <ThumbsUp size={15} />
                        </button>
                        <button
                          type="button"
                          className="pf-icon-button"
                          aria-label="Bad response"
                          title="Bad response"
                        >
                          <ThumbsDown size={15} />
                        </button>
                      </div>
                    </MessagePrimitive.If>
                  </MessagePrimitive.Root>
                ),
              }}
            />
            <AuiIf
              condition={(s) =>
                s.thread.isRunning &&
                s.thread.messages.length > 0 &&
                s.thread.messages[s.thread.messages.length - 1]?.role !==
                  "assistant"
              }
            >
              <div role="status" className="pf-running">
                <span className="pf-status-dot" />
                Working on your response…
              </div>
            </AuiIf>
          </div>
          <ThreadPrimitive.ViewportFooter className="pf-transcript-footer">
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

function AttachmentChip({ removable = false }: { removable?: boolean }) {
  const attachment = useAuiState((s) => s.attachment);
  const error =
    attachment.status.type === "incomplete"
      ? attachment.status.message
      : undefined;
  return (
    <AttachmentPrimitive.Root
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        fontSize: 13,
      }}
    >
      {attachment.type === "image" ? (
        <ImagePlus size={16} aria-hidden="true" />
      ) : (
        <Paperclip size={16} aria-hidden="true" />
      )}
      <AttachmentPrimitive.Name />
      {removable && (
        <AttachmentPrimitive.Remove
          className="pf-icon-button"
          aria-label={`Remove ${attachment.name}`}
          title={`Remove ${attachment.name}`}
        >
          <X size={14} />
        </AttachmentPrimitive.Remove>
      )}
      {error && (
        <span role="alert" className="pf-error">
          {error}
        </span>
      )}
    </AttachmentPrimitive.Root>
  );
}

function ComposerAttachment() {
  return <AttachmentChip removable />;
}

function MessageAttachment() {
  return <AttachmentChip />;
}

function ClaudeComposer({
  selectedModel,
  onSelectModel,
}: {
  selectedModel: string;
  onSelectModel: (id: string) => void;
}) {
  return (
    <ComposerPrimitive.Root className="pf-composer">
      <ComposerPrimitive.Attachments
        components={{ Attachment: ComposerAttachment }}
      />
      <ComposerPrimitive.Input
        className="pf-composer-input"
        aria-label="Message"
        placeholder="Ask a question, explore an idea, or make something…"
      />
      <div className="pf-composer-toolbar">
        <div className="pf-composer-tools">
          <ComposerPlusMenu />
        </div>
        <div className="pf-composer-controls">
          <ModelDropdown selected={selectedModel} onSelect={onSelectModel} />
          <button
            type="button"
            className="pf-icon-button pf-voice-button"
            aria-label="Voice input"
            title="Voice input"
          >
            <Mic size={17} />
          </button>
          <button
            type="button"
            className="pf-icon-button pf-voice-button"
            aria-label="Voice mode"
            title="Voice mode"
          >
            <AudioWaveform size={17} />
          </button>
          <ComposerPrimitive.Send
            className="pf-send"
            aria-label="Send message"
            title="Send message"
          >
            <ArrowUpIcon size={18} />
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningByModel, setReasoningByModel] = useState<
    Record<string, string>
  >({});
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    () => window.innerWidth >= 860,
  );
  const mobile = useMobileViewport();
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
  const [chatgptDiscovery, setChatgptDiscovery] = useState<ModelDiscovery>({
    models: [],
    loading: true,
    error: null,
  });
  const [geminiDefaultModel, setGeminiDefaultModel] = useState<
    string | undefined
  >();
  const models = useMemo(
    () => [
      ...chatgptDiscovery.models,
      ...claudeDiscovery.models,
      ...geminiDiscovery.models,
    ],
    [chatgptDiscovery.models, claudeDiscovery.models, geminiDiscovery.models],
  );

  useEffect(() => {
    const selected = models.find((model) => model.id === selectedModel);
    if (!selected || selected.disabled) {
      if (
        !selectedModel &&
        (claudeDiscovery.loading ||
          geminiDiscovery.loading ||
          chatgptDiscovery.loading)
      )
        return;
      const available =
        models.find(
          (model) => model.id === geminiDefaultModel && !model.disabled,
        ) ?? models.find((model) => !model.disabled);
      if (available) setSelectedModel(available.id);
    }
    setReasoningByModel((previous) => {
      let next = previous;
      for (const [id, selected] of Object.entries(previous)) {
        const model = models.find((candidate) => candidate.id === id);
        const levels = model?.reasoningLevels;
        if (
          model &&
          (!levels || levels.some((level) => level.value === selected))
        )
          continue;
        if (next === previous) next = { ...previous };
        const fallback =
          levels?.find(
            (level) => level.value === model?.defaultReasoningLevel,
          ) ?? levels?.[0];
        if (fallback) next[id] = fallback.value;
        else delete next[id];
      }
      return next;
    });
  }, [
    models,
    selectedModel,
    geminiDefaultModel,
    claudeDiscovery.loading,
    geminiDiscovery.loading,
    chatgptDiscovery.loading,
  ]);

  useEffect(() => {
    let active: AbortController | undefined;
    async function loadChatgptModels(abort: AbortController) {
      try {
        const response = await fetch("/api/providers/chatgpt-web/models", {
          signal: abort.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "ChatGPT model discovery failed");
        const catalog = data as ChatGptModelCatalog;
        const discovered = catalog.models.map((model): ModelOption => ({
          id: model.id,
          name: model.name,
          provider: "chatgpt-web",
          disabled: model.disabled,
          availability: model.disabled
            ? (model.disabledReason ?? "Unavailable")
            : "Available",
          reasoningLevels: model.reasoningLevels
            .filter((level) => !level.disabled)
            .map(({ value, label }) => ({ value, label })),
          defaultReasoningLevel: model.defaultReasoningLevel,
        }));
        if (!abort.signal.aborted)
          setChatgptDiscovery({
            models: discovered,
            loading: false,
            error: null,
          });
      } catch (error) {
        if (!abort.signal.aborted)
          setChatgptDiscovery((previous) => ({
            ...previous,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "ChatGPT model discovery failed",
          }));
      }
    }
    async function loadClaudeModels(abort: AbortController) {
      try {
        const response = await fetch("/api/providers/claude-web/models", {
          signal: abort.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Claude model discovery failed");
        const catalog = data as ClaudeModelCatalog;
        const discovered = catalog.models.map((model): ModelOption => {
          const supportedEfforts =
            model.capabilities?.supportedThinkingEfforts ?? [];
          const reasoningLevels =
            supportedEfforts.length > 0
              ? supportedEfforts.map((eff) => ({
                  value: eff,
                  label:
                    eff === "xhigh"
                      ? "XHigh"
                      : eff.charAt(0).toUpperCase() + eff.slice(1),
                }))
              : undefined;
          return {
            id: model.id,
            name: model.name,
            provider: "claude-web",
            disabled: model.disabled,
            availability: model.disabled
              ? `${model.badge ?? model.requiredPlan ?? "Unavailable"} — ${model.disabledReason === "upgrade_required" ? "Upgrade required" : "Unavailable"}`
              : model.section === "overflow"
                ? "Available · More models"
                : "Available",
            reasoningLevels,
            defaultReasoningLevel: reasoningLevels
              ? reasoningLevels[0]?.value
              : undefined,
          };
        });
        if (!abort.signal.aborted)
          setClaudeDiscovery({
            models: discovered,
            loading: false,
            error: null,
          });
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
    async function loadGeminiModels(abort: AbortController) {
      try {
        const response = await fetch("/api/providers/gemini-web/models", {
          signal: abort.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Gemini Web model discovery failed");
        const catalog = data as GeminiModelCatalog;
        const GEMINI_REASONING_LEVELS = [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ] as const;
        const discovered = catalog.models.map((model): ModelOption => ({
          id: model.id,
          name: model.name,
          provider: "gemini-web",
          disabled: model.disabled,
          availability: model.availability,
          reasoningLevels: GEMINI_REASONING_LEVELS,
          defaultReasoningLevel: "low",
        }));
        if (!abort.signal.aborted) {
          setGeminiDefaultModel(catalog.defaultModel);
          setGeminiDiscovery({
            models: discovered,
            loading: false,
            error: null,
          });
        }
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
    function reloadCatalogs() {
      active?.abort();
      const abort = new AbortController();
      active = abort;
      setChatgptDiscovery((previous) => ({ ...previous, loading: true }));
      setClaudeDiscovery((previous) => ({ ...previous, loading: true }));
      setGeminiDiscovery((previous) => ({ ...previous, loading: true }));
      void loadChatgptModels(abort);
      void loadClaudeModels(abort);
      void loadGeminiModels(abort);
    }
    const reloadVisibleCatalogs = () => {
      if (document.visibilityState === "visible") reloadCatalogs();
    };
    reloadCatalogs();
    window.addEventListener("focus", reloadVisibleCatalogs);
    document.addEventListener("visibilitychange", reloadVisibleCatalogs);
    const interval = window.setInterval(reloadVisibleCatalogs, 5 * 60 * 1000);
    return () => {
      active?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", reloadVisibleCatalogs);
      document.removeEventListener("visibilitychange", reloadVisibleCatalogs);
    };
  }, []);

  const currentProvider = models.find((m) => m.id === selectedModel)?.provider;
  const providerRef = useRef(currentProvider);
  providerRef.current = currentProvider;
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const attachmentAdapter = useMemo(
    () =>
      createAttachmentAdapter({
        getProvider: () => providerRef.current,
        getAttachments: (submission) => {
          const state = runtimeRef.current?.thread.composer.getState();
          return (
            (submission
              ? state?.submission?.attachments
              : state?.attachments) ?? []
          );
        },
        onError: setRuntimeError,
      }),
    [activeThreadId, chatKey],
  );
  const runtime = useChatRuntime({
    id: `thread-${activeThreadId}-${chatKey}`,
    adapters: { attachments: attachmentAdapter },
    onError: (error) => {
      // HTTP failures may carry a JSON error body; show its safe public message.
      let message =
        error.message || "The chat request failed. Please try again.";
      try {
        const parsed = JSON.parse(message) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {}
      setRuntimeError(message);
    },
    onFinish: ({ isError }) => {
      if (!isError) setRuntimeError(null);
    },
    transport: new AssistantChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ id, messages }) => {
        const currentModel = models.find((m) => m.id === selectedModel);
        const levels =
          currentModel?.reasoningLevels ??
          (currentModel?.provider === "chatgpt-web" ||
          currentModel?.provider === "claude-web" ||
          currentModel?.provider === "gemini-web"
            ? []
            : undefined);
        const selectedLevel = reasoningByModel[selectedModel];
        const effectiveReasoning = levels
          ? (
              levels.find((level) => level.value === selectedLevel) ??
              levels.find(
                (level) => level.value === currentModel?.defaultReasoningLevel,
              ) ??
              levels[0]
            )?.value
          : selectedLevel;
        return {
          body: {
            id,
            messages,
            model: selectedModel,
            provider: currentProvider,
            reasoning_effort: effectiveReasoning,
          },
        };
      },
    }),
  });
  runtimeRef.current = runtime;
  useEffect(
    () =>
      runtime.thread.composer.unstable_on(
        "attachmentAddError",
        ({ message }) => {
          setRuntimeError(message);
        },
      ),
    [runtime],
  );

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
        onReasoningChange: (model, value) =>
          setReasoningByModel((previous) => ({ ...previous, [model]: value })),
        discoveries: [
          {
            name: "ChatGPT",
            loading: chatgptDiscovery.loading,
            error: chatgptDiscovery.error,
          },
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
          <ResponsiveSidebar
            open={isSidebarOpen}
            onOpen={() => setIsSidebarOpen(true)}
            onClose={() => setIsSidebarOpen(false)}
          >
            <Sidebar
              onSettings={() => {
                if (mobile) setIsSidebarOpen(false);
                setSettingsOpen(true);
              }}
              isOpen={mobile || isSidebarOpen}
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
          </ResponsiveSidebar>
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
      {settingsOpen && (
        <ClaudeSettings onClose={() => setSettingsOpen(false)} />
      )}
    </ModelCatalogContext.Provider>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
