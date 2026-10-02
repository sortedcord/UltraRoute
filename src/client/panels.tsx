import React, { createContext, useContext, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FolderOpen,
  Globe,
  HelpCircle,
  Info,
  KeyRound,
  LoaderCircle,
  LogOut,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  LayoutGrid,
  X,
} from "lucide-react";
import { DEFAULT_REASONING_LEVELS, ReasoningSlider, reasoningChoice, type ReasoningLevel } from "./reasoning.tsx";
import { ResponsiveMenu, useMobileViewport } from "./mobileDrawer.tsx";

export interface ModelOption {
  id: string;
  name: string;
  effort?: string;
  provider: string;
  disabled?: boolean;
  availability?: string;
  reasoningLevels?: readonly ReasoningLevel[];
  defaultReasoningLevel?: string;
}

export interface ModelDiscovery {
  models: ModelOption[];
  loading: boolean;
  error: string | null;
}

export interface SavedThread {
  id: string;
  title: string;
  createdAt: number;
}

export const ModelCatalogContext = createContext<{
  models: ModelOption[];
  discoveries: { name: string; loading: boolean; error: string | null }[];
  reasoningByModel: Record<string, string>;
  onReasoningChange: (model: string, value: string) => void;
}>({ models: [], discoveries: [], reasoningByModel: {}, onReasoningChange: () => { throw new Error("ModelCatalogContext provider is required"); } });

type SettingsSection = "General" | "Account" | "Privacy" | "Billing" | "Capabilities" | "Memory" | "Reflect" | "Time and focus" | "Claude Code" | "Skills" | "Connectors" | "Plugins";

const SETTINGS_NAV: { title: string; items: SettingsSection[] }[] = [
  { title: "Settings", items: ["General", "Account", "Privacy", "Billing", "Capabilities", "Memory", "Reflect", "Time and focus", "Claude Code"] },
  { title: "Customize", items: ["Skills", "Connectors", "Plugins"] },
];

export function ClaudeSettings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>("General");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("System");
  const [font, setFont] = useState("Anthropic Serif");
  const [width, setWidth] = useState("Narrow");
  const [motion, setMotion] = useState("System");
  const [voiceLanguage, setVoiceLanguage] = useState("English");
  const [voiceStyle, setVoiceStyle] = useState("Rounded");
  const [voiceSpeed, setVoiceSpeed] = useState("Normal");
  const [notifications, setNotifications] = useState(true);
  const dialogRef = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, [tabindex='0']");
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);

  const choose = (label: string, options: string[], value: string, change: (next: string) => void) => (
    <div className="pf-segmented" role="group" aria-label={label}>
      {options.map(option => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => change(option)}>{option}</button>
      ))}
    </div>
  );
  const row = (title: string, description: string | undefined, control: React.ReactNode) => (
    <div className="pf-settings-field">
      <div className="pf-field-label">{title}</div>
      {description && <p className="pf-field-description">{description}</p>}
      <div className="pf-field-control">{control}</div>
    </div>
  );
  const select = (label: string, value: string, options: string[], change: (next: string) => void) => (
    <div className="pf-select-wrap">
      <select aria-label={label} value={value} onChange={event => change(event.target.value)}>
        {options.map(option => <option key={option}>{option}</option>)}
      </select>
      <ChevronDown size={16} aria-hidden="true" />
    </div>
  );

  return (
    <div className="pf-settings-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="pf-settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <button ref={closeRef} className="pf-panel-icon-button pf-settings-close" type="button" aria-label="Close settings" onClick={onClose}><X size={20} aria-hidden="true" /></button>
        <nav className="pf-settings-nav" aria-label="Settings">
          <h2>Settings</h2>
          <div className="pf-settings-search">
            <Search size={16} aria-hidden="true" />
            <input aria-label="Search settings" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <div className="pf-settings-nav-groups">
            {SETTINGS_NAV.map(group => {
              const items = group.items.filter(item => item.toLowerCase().includes(query.toLowerCase()));
              if (!items.length) return null;
              return (
                <div key={group.title} className="pf-settings-nav-group">
                  <div className="pf-group-label">{group.title}</div>
                  <div className="pf-settings-nav-items">
                    {items.map(item => <button key={item} type="button" aria-current={section === item ? "page" : undefined} onClick={() => setSection(item)}>{item}</button>)}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="pf-settings-api"><ArrowUpRight size={16} aria-hidden="true" />API keys</div>
        </nav>
        <main className="pf-settings-content">
          {section === "General" ? (
            <div className="pf-settings-form">
              <h3>Appearance</h3>
              {row("Theme", undefined, choose("Theme", ["System", "Light", "Dark"], theme, setTheme))}
              {row("Chat font", undefined, select("Chat font", font, ["Anthropic Serif", "Sans Serif", "System"], setFont))}
              {row("Transcript width", "Maximum width of the transcript and composer columns.", choose("Transcript width", ["Narrow", "Medium", "Wide"], width, setWidth))}
              {row("Motion", "Reduce animation in streaming responses and other interface elements.", choose("Motion", ["System", "Reduced"], motion, setMotion))}
              <h3>Voice</h3>
              {row("Language", undefined, select("Language", voiceLanguage, ["English", "Spanish", "French", "German", "Japanese"], setVoiceLanguage))}
              {row("Style", undefined, select("Style", voiceStyle, ["Rounded", "Natural", "Professional"], setVoiceStyle))}
              {row("Speed", undefined, select("Speed", voiceSpeed, ["Slow", "Normal", "Fast"], setVoiceSpeed))}
              <h3>Notifications</h3>
              {row("Response completions", "Get notified when Claude has finished a response. Useful for long-running tasks.", (
                <button className="pf-switch" type="button" role="switch" aria-checked={notifications} aria-label="Response completions" onClick={() => setNotifications(!notifications)}><span /></button>
              ))}
            </div>
          ) : (
            <div className="pf-settings-form">
              <h3>{section}</h3>
              <p className="pf-settings-description">Manage {section.toLowerCase()} preferences for your UltraRoute session.</p>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

const MODEL_GROUPS = [
  { id: "openai", name: "OpenAI", discovery: null, icon: "openai" },
  { id: "gemini", name: "Gemini", discovery: "Gemini Web", icon: "googlegemini" },
  { id: "claude", name: "Claude", discovery: "Claude", icon: "claude" },
  { id: "misc", name: "Miscellaneous", discovery: null, icon: null },
] as const;

function modelGroup(provider: string) {
  switch (provider) {
    case "chatgpt-web": return "openai";
    case "gemini-web": return "gemini";
    case "claude-web": return "claude";
    default: return "misc";
  }
}


export function ModelDropdown({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const mobile = useMobileViewport();
  const { models, discoveries, reasoningByModel, onReasoningChange } = useContext(ModelCatalogContext);
  const current = models.find(model => model.id === selected) ?? models[0];
  const [activeGroup, setActiveGroup] = useState(() => modelGroup(current?.provider ?? ""));
  const group = MODEL_GROUPS.find(item => item.id === activeGroup)!;
  const visibleModels = models.filter(model => modelGroup(model.provider) === activeGroup);
  const discovery = discoveries.find(item => item.name === group.discovery);
  const largestGroupSize = Math.max(...MODEL_GROUPS.map(item => models.filter(model => modelGroup(model.provider) === item.id).length));
  const menuHeight = Math.max(262, 112 + largestGroupSize * 58);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const selectorRef = React.useRef<HTMLDivElement>(null);
  const reasoningLevels = current?.reasoningLevels ?? DEFAULT_REASONING_LEVELS;
  const reasoningLevel = reasoningLevels[reasoningChoice(reasoningLevels, current ? reasoningByModel[current.id] : undefined, current?.defaultReasoningLevel)];

  useEffect(() => {
    if (!open || mobile) return;
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !selectorRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("keydown", closeEscape);
      document.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [open, mobile]);

  return (
    <div ref={selectorRef} className="pf-model-selector">
      <button ref={triggerRef} className="pf-model-trigger" type="button" aria-label={`Select model: ${current?.name ?? "No model selected"}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { if (!open) setActiveGroup(modelGroup(current?.provider ?? "")); setOpen(!open); }}>
        <span className="pf-model-name">{current?.name ?? "Select model"}</span>
        {reasoningLevel && <span className="pf-model-effort">{reasoningLevel.label}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <ResponsiveMenu open={open} onClose={() => setOpen(false)} label="Choose a model">
        <div className="pf-model-menu" role={mobile ? undefined : "dialog"} aria-label={mobile ? undefined : "Choose a model"} style={{ height: menuHeight }}>
          <div className="pf-model-menu-body">
          <div className="pf-model-provider-rail" role="tablist" aria-label="Model providers" aria-orientation="vertical">
            {MODEL_GROUPS.map((item, index) => (
              <button key={item.id} id={`pf-provider-${item.id}`} type="button" role="tab" className="pf-model-provider-tab" aria-label={item.name} title={item.name} aria-selected={activeGroup === item.id} aria-controls="pf-provider-models" tabIndex={activeGroup === item.id ? 0 : -1} onClick={() => setActiveGroup(item.id)} onKeyDown={event => {
                let next = index;
                if (event.key === "ArrowDown") next = (index + 1) % MODEL_GROUPS.length;
                else if (event.key === "ArrowUp") next = (index + MODEL_GROUPS.length - 1) % MODEL_GROUPS.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = MODEL_GROUPS.length - 1;
                else return;
                event.preventDefault();
                setActiveGroup(MODEL_GROUPS[next].id);
                (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
              }}>
                {item.icon ? <img width={22} height={22} alt="" aria-hidden="true" src={`https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/${item.icon}.svg`} /> : <Settings size={22} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div id="pf-provider-models" className="pf-model-provider-content" role="tabpanel" aria-labelledby={`pf-provider-${activeGroup}`}>
            <div className="pf-model-provider-list">
            <div className="pf-menu-heading">{group.name}<span className="pf-model-group-count">{visibleModels.length}</span></div>
            {discovery?.loading && <div className="pf-model-discovery" role="status"><LoaderCircle className="pf-discovery-spinner" size={15} aria-hidden="true" /><span>Loading {discovery.name} models…</span></div>}
            {discovery?.error && <div className="pf-model-discovery pf-model-error" role="alert"><Info size={15} aria-hidden="true" /><span>{discovery.name}: {discovery.error}</span></div>}
            <div role="menu" aria-label={`${group.name} models`}>
              {visibleModels.map(model => (
                <button key={model.id} className="pf-model-option" type="button" role="menuitemradio" aria-checked={model.id === selected} disabled={model.disabled} onClick={() => { onSelect(model.id); }}>
                  <span className="pf-model-option-copy">
                    <span className="pf-model-option-name">{model.name}</span>
                    <span className="pf-model-option-detail">{model.provider === "google" ? "API · " : ""}{model.availability ?? (model.effort ? `${model.effort} reasoning` : "Available")}</span>
                  </span>
                  {model.id === selected && <span className="pf-model-selected"><Check size={13} aria-hidden="true" /></span>}
                </button>
              ))}
            </div>
            {!visibleModels.length && !discovery?.loading && !discovery?.error && <p className="pf-model-discovery">No models available.</p>}
            </div>
          </div>
          </div>
            {current && reasoningLevel && <ReasoningSlider levels={reasoningLevels} value={reasoningLevel.value} onChange={value => onReasoningChange(current.id, value)} />}
        </div>
      </ResponsiveMenu>
    </div>
  );
}

export function Sidebar({
  onSettings,
  isOpen,
  onToggle,
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  onSettings: () => void;
  isOpen: boolean;
  onToggle: () => void;
  threads: SavedThread[];
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [language, setLanguage] = useState("English");
  const [copied, setCopied] = useState(false);
  const profileMenuRef = React.useRef<HTMLDivElement>(null);
  const profileTriggerRef = React.useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
        setLanguageMenuOpen(false);
      }
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
        setLanguageMenuOpen(false);
        profileTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [accountMenuOpen]);

  const copyAddress = async () => {
    await navigator.clipboard.writeText("adityakqx@gmail.com");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const openSettings = () => {
    profileTriggerRef.current?.focus();
    setAccountMenuOpen(false);
    onSettings();
  };
  if (!isOpen) return null;

  return (
    <aside className="pf-sidebar" aria-label="Chat sidebar">
      <div className="pf-sidebar-header">
        <span className="pf-sidebar-wordmark"><span className="pf-brand-prism" aria-hidden="true" />UltraRoute</span>
        <button className="pf-panel-icon-button" type="button" aria-label="Collapse sidebar" aria-expanded={isOpen} title="Collapse sidebar" onClick={onToggle}><PanelLeftClose size={18} aria-hidden="true" /></button>
      </div>
      <div className="pf-sidebar-new-wrap">
        <button className="pf-sidebar-new" type="button" onClick={onNewThread}><Plus size={18} aria-hidden="true" /><span>New</span></button>
      </div>
      <div className="pf-sidebar-navigation">
        <div className="pf-group-label">Workspace</div>
        <div className="pf-sidebar-nav-item"><FolderOpen size={18} aria-hidden="true" /><span>Projects</span></div>
        <div className="pf-sidebar-nav-item"><LayoutGrid size={18} aria-hidden="true" /><span>Artifacts</span></div>
        <div className="pf-sidebar-nav-item"><Code2 size={18} aria-hidden="true" /><span>Code</span></div>
        <div className="pf-sidebar-nav-item"><SlidersHorizontal size={18} aria-hidden="true" /><span>Customize</span></div>
      </div>
      <div className="pf-sidebar-threads">
        <div className="pf-group-label">Chats and tasks</div>
        {threads.map(thread => (
          <div key={thread.id} className={`pf-thread-row${thread.id === activeThreadId ? " pf-thread-row-active" : ""}`}>
            <button className="pf-thread-select" type="button" aria-current={thread.id === activeThreadId ? "page" : undefined} title={thread.title} onClick={() => onSelectThread(thread.id)}><span>{thread.title}</span></button>
            <button className="pf-thread-delete pf-panel-icon-button" type="button" aria-label={`Delete chat: ${thread.title}`} title="Delete chat" onClick={() => onDeleteThread(thread.id)}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
      <div ref={profileMenuRef} className="pf-profile">
        {accountMenuOpen && (
          <div className="pf-account-menu" role="menu" aria-label="Account menu">
            <button className="pf-account-address" type="button" role="menuitem" aria-label="Copy account email address" onClick={copyAddress}>{copied ? "Copied" : "adityakqx@gmail.com"}</button>
            <button className="pf-account-item" type="button" role="menuitem" onClick={openSettings}><Settings size={16} aria-hidden="true" /><span>Settings</span><span className="pf-account-shortcut">Ctrl+Shift+,</span></button>
            <button className="pf-account-item" type="button" role="menuitem" aria-haspopup="menu" aria-expanded={languageMenuOpen} onClick={() => setLanguageMenuOpen(!languageMenuOpen)}><Globe size={16} aria-hidden="true" /><span>Language</span><ChevronRight className="pf-account-chevron" size={15} aria-hidden="true" /></button>
            {languageMenuOpen && (
              <div className="pf-language-menu" role="menu" aria-label="Language">
                {["English", "Español", "Français", "Deutsch", "日本語"].map(item => <button className="pf-account-item" key={item} type="button" role="menuitemradio" aria-checked={language === item} onClick={() => { setLanguage(item); setLanguageMenuOpen(false); }}><span>{item}</span>{language === item && <Check className="pf-account-chevron" size={14} aria-hidden="true" />}</button>)}
              </div>
            )}
            <button className="pf-account-item" type="button" role="menuitem" onClick={openSettings}><HelpCircle size={16} aria-hidden="true" /><span>Get help</span></button>
            <div className="pf-menu-divider" role="separator" />
            <button className="pf-account-item" type="button" role="menuitem" onClick={openSettings}><ArrowUpRight size={16} aria-hidden="true" /><span>Upgrade plan</span></button>
            <button className="pf-account-item" type="button" role="menuitem" onClick={openSettings}><Download size={16} aria-hidden="true" /><span>Get apps and extensions</span></button>
            <button className="pf-account-item" type="button" role="menuitem" onClick={openSettings}><Info size={16} aria-hidden="true" /><span>Learn more</span><ChevronRight className="pf-account-chevron" size={15} aria-hidden="true" /></button>
            <div className="pf-menu-divider" role="separator" />
            <button className="pf-account-item" type="button" role="menuitem" onClick={openSettings}><KeyRound size={16} aria-hidden="true" /><span>Get API keys<small>on Claude Platform</small></span><ArrowUpRight className="pf-account-chevron" size={15} aria-hidden="true" /></button>
            <div className="pf-menu-divider" role="separator" />
            <button className="pf-account-item" type="button" role="menuitem" onClick={() => setAccountMenuOpen(false)}><LogOut size={16} aria-hidden="true" /><span>Log out</span></button>
          </div>
        )}
        <button ref={profileTriggerRef} className="pf-profile-trigger" type="button" aria-haspopup="menu" aria-expanded={accountMenuOpen} aria-label="UltraRoute User Free session" onClick={() => { setAccountMenuOpen(!accountMenuOpen); setLanguageMenuOpen(false); }}>
          <span className="pf-profile-avatar" aria-hidden="true">AG</span>
          <span className="pf-profile-copy"><span className="pf-profile-name">UltraRoute User</span><span className="pf-profile-plan">Free session</span></span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
