import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Globe2,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Smartphone,
  TerminalSquare,
  X,
} from "lucide-react";
import { IconButton } from "./IconButton";
import {
  getBrowserPanelPreview,
  isDesktop,
  listBrowserPanelSessions,
  runBrowserPanelCommand,
  startBrowserPanelSession,
  type BrowserPanelCommand,
} from "../lib/bridge";
import type { BrowserConsoleEntry, BrowserPreview, BrowserSessionSummary } from "../lib/types";

interface AgentBrowserPanelProps {
  threadId: string;
  workspace?: string;
  sessionHint?: string | null;
  revision: number;
  running: boolean;
  onNotice: (message: string) => void;
}

interface BrowserPoint {
  x: number;
  y: number;
}

interface PendingWheel extends BrowserPoint {
  deltaX: number;
  deltaY: number;
}

const SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const TEXT_BATCH_DELAY_MS = 48;
const WHEEL_THROTTLE_MS = 72;
const MAX_KEY_TEXT_LENGTH = 32;

function tx(zh: string, en: string) {
  const language = typeof document !== "undefined"
    ? document.documentElement.lang || navigator.language
    : "zh-CN";
  return language.toLocaleLowerCase().startsWith("zh") ? zh : en;
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function normalizedBrowserUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

function displayUrl(url: string) {
  return url === "about:blank" ? "" : url;
}

function sessionLabel(session: BrowserSessionSummary, index: number) {
  if (session.title.trim()) return session.title.trim();
  if (session.url && session.url !== "about:blank") {
    try {
      return new URL(session.url).host || session.url;
    } catch {
      return session.url;
    }
  }
  return tx(`浏览器 ${index + 1}`, `Browser ${index + 1}`);
}

function summaryFromPreview(
  preview: BrowserPreview,
  previous?: BrowserSessionSummary,
): BrowserSessionSummary {
  return {
    id: preview.sessionId,
    threadId: preview.threadId,
    createdAt: previous?.createdAt ?? preview.updatedAt,
    lastActiveAt: preview.updatedAt,
    url: preview.url,
    title: preview.title,
    viewportWidth: preview.viewportWidth,
    viewportHeight: preview.viewportHeight,
    mobile: preview.mobile,
    allowedDomains: previous?.allowedDomains ?? [],
  };
}

function sortedSessions(sessions: BrowserSessionSummary[]) {
  return [...sessions].sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

function consoleTime(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "--:--:--";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function sanitizedConsoleEntries(entries: unknown): BrowserConsoleEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is BrowserConsoleEntry => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<BrowserConsoleEntry>;
    return ["log", "info", "warn", "error", "debug"].includes(candidate.level ?? "")
      && typeof candidate.text === "string"
      && typeof candidate.timestamp === "number"
      && Number.isFinite(candidate.timestamp)
      && !Number.isNaN(new Date(candidate.timestamp).getTime());
  });
}

export function AgentBrowserPanel({
  threadId,
  workspace,
  sessionHint,
  revision,
  running,
  onNotice,
}: AgentBrowserPanelProps) {
  const desktop = isDesktop();
  const [sessions, setSessions] = useState<BrowserSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<BrowserPreview | null>(null);
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(desktop);
  const [pendingOperations, setPendingOperations] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);

  const imageRef = useRef<HTMLImageElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const addressEditingRef = useRef(false);
  const mountedRef = useRef(true);
  const threadIdRef = useRef(threadId);
  const activeSessionIdRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTextRef = useRef("");
  const textTimerRef = useRef<number | undefined>(undefined);
  const pendingWheelRef = useRef<PendingWheel | null>(null);
  const wheelTimerRef = useRef<number | undefined>(undefined);

  threadIdRef.current = threadId;
  activeSessionIdRef.current = activeSessionId;

  const interactionsDisabled = running || pendingOperations > 0;

  function reportError(reason: unknown, notify = false) {
    const message = errorText(reason);
    if (!mountedRef.current) return;
    setError(message);
    if (notify) onNotice(message);
  }

  function applyPreview(next: BrowserPreview, expectedThreadId = threadIdRef.current) {
    if (!mountedRef.current || threadIdRef.current !== expectedThreadId) return;
    const sanitized = { ...next, consoleEntries: sanitizedConsoleEntries(next.consoleEntries) };
    setPreview(sanitized);
    activeSessionIdRef.current = sanitized.sessionId;
    setActiveSessionId(sanitized.sessionId);
    setSessions((current) => sortedSessions([
      summaryFromPreview(sanitized, current.find((session) => session.id === sanitized.sessionId)),
      ...current.filter((session) => session.id !== sanitized.sessionId),
    ]));
    if (!addressEditingRef.current) setAddress(displayUrl(sanitized.url));
    setError(null);
  }

  async function loadPreview(sessionId: string, expectedThreadId = threadIdRef.current) {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const next = await getBrowserPanelPreview(sessionId);
      if (
        generation !== loadGenerationRef.current
        || threadIdRef.current !== expectedThreadId
        || activeSessionIdRef.current !== sessionId
      ) return;
      applyPreview(next, expectedThreadId);
    } catch (reason) {
      if (generation === loadGenerationRef.current && threadIdRef.current === expectedThreadId) {
        reportError(reason);
      }
    } finally {
      if (generation === loadGenerationRef.current && mountedRef.current) setLoading(false);
    }
  }

  function enqueueCommand(command: BrowserPanelCommand, notifyOnError = true) {
    const expectedThreadId = threadIdRef.current;
    setPendingOperations((current) => current + 1);
    const task = commandQueueRef.current.then(async () => {
      try {
        const next = await runBrowserPanelCommand(command);
        if (next) applyPreview(next, expectedThreadId);
      } catch (reason) {
        if (threadIdRef.current === expectedThreadId) reportError(reason, notifyOnError);
      } finally {
        if (mountedRef.current) setPendingOperations((current) => Math.max(0, current - 1));
      }
    });
    commandQueueRef.current = task.catch(() => undefined);
    return task;
  }

  function enqueueText(text: string) {
    if (!text || !activeSessionIdRef.current || running) return;
    pendingTextRef.current += text;
    if (textTimerRef.current !== undefined) window.clearTimeout(textTimerRef.current);

    const characters = Array.from(pendingTextRef.current);
    if (characters.length >= MAX_KEY_TEXT_LENGTH) {
      flushPendingText();
      return;
    }
    textTimerRef.current = window.setTimeout(flushPendingText, TEXT_BATCH_DELAY_MS);
  }

  function flushPendingText() {
    if (textTimerRef.current !== undefined) window.clearTimeout(textTimerRef.current);
    textTimerRef.current = undefined;
    const sessionId = activeSessionIdRef.current;
    const characters = Array.from(pendingTextRef.current);
    pendingTextRef.current = "";
    if (!sessionId || running || characters.length === 0) return;
    for (let index = 0; index < characters.length; index += MAX_KEY_TEXT_LENGTH) {
      const text = characters.slice(index, index + MAX_KEY_TEXT_LENGTH).join("");
      void enqueueCommand({ sessionId, action: "key", key: "Unidentified", text });
    }
  }

  function viewportPoint(clientX: number, clientY: number): BrowserPoint | null {
    const image = imageRef.current;
    if (!image || !preview) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(preview.viewportWidth, Math.max(0, (clientX - rect.left) / rect.width * preview.viewportWidth)),
      y: Math.min(preview.viewportHeight, Math.max(0, (clientY - rect.top) / rect.height * preview.viewportHeight)),
    };
  }

  function handleCanvasClick(event: ReactMouseEvent<HTMLImageElement>) {
    if (interactionsDisabled || !activeSessionId) return;
    const point = viewportPoint(event.clientX, event.clientY);
    if (!point) return;
    keyboardRef.current?.focus({ preventScroll: true });
    void enqueueCommand({ sessionId: activeSessionId, action: "click", ...point });
  }

  function flushWheel() {
    if (wheelTimerRef.current !== undefined) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = undefined;
    const sessionId = activeSessionIdRef.current;
    const wheel = pendingWheelRef.current;
    pendingWheelRef.current = null;
    if (!sessionId || running || !wheel) return;
    void enqueueCommand({ sessionId, action: "scroll", ...wheel });
  }

  function handleCanvasWheel(event: ReactWheelEvent<HTMLImageElement>) {
    if (interactionsDisabled || !activeSessionId) return;
    const point = viewportPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = {
      ...point,
      deltaX: (pending?.deltaX ?? 0) + event.deltaX,
      deltaY: (pending?.deltaY ?? 0) + event.deltaY,
    };
    if (wheelTimerRef.current === undefined) {
      wheelTimerRef.current = window.setTimeout(flushWheel, WHEEL_THROTTLE_MS);
    }
  }

  function handleKeyboardInput(event: FormEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as InputEvent;
    if (nativeEvent.isComposing) return;
    const value = event.currentTarget.value;
    event.currentTarget.value = "";
    enqueueText(value);
  }

  function handleKeyboardKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (running || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!SPECIAL_KEYS.has(event.key) || !activeSessionId) return;
    event.preventDefault();
    flushPendingText();
    void enqueueCommand({ sessionId: activeSessionId, action: "key", key: event.key });
  }

  async function createSession(useAddress: boolean) {
    if (!desktop || running) return;
    const expectedThreadId = threadIdRef.current;
    setPendingOperations((current) => current + 1);
    setError(null);
    try {
      const url = useAddress ? normalizedBrowserUrl(address) : undefined;
      const next = await startBrowserPanelSession(threadId, workspace, url);
      applyPreview(next, expectedThreadId);
    } catch (reason) {
      if (threadIdRef.current === expectedThreadId) reportError(reason, true);
    } finally {
      if (mountedRef.current) setPendingOperations((current) => Math.max(0, current - 1));
    }
  }

  function navigate() {
    if (!activeSessionId || interactionsDisabled) return;
    const url = normalizedBrowserUrl(address);
    if (!url) return;
    keyboardRef.current?.blur();
    void enqueueCommand({ sessionId: activeSessionId, action: "navigate", url });
  }

  async function closeSession() {
    if (!activeSessionId || interactionsDisabled) return;
    const closingId = activeSessionId;
    await enqueueCommand({ sessionId: closingId, action: "close" });
    if (!mountedRef.current || activeSessionIdRef.current !== closingId) return;
    const remaining = sessions.filter((session) => session.id !== closingId);
    const next = remaining[0];
    setSessions(remaining);
    setPreview(null);
    activeSessionIdRef.current = next?.id ?? null;
    setActiveSessionId(next?.id ?? null);
    setAddress("");
    if (next) void loadPreview(next.id);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      if (textTimerRef.current !== undefined) window.clearTimeout(textTimerRef.current);
      if (wheelTimerRef.current !== undefined) window.clearTimeout(wheelTimerRef.current);
    };
  }, []);

  useEffect(() => {
    pendingTextRef.current = "";
    pendingWheelRef.current = null;
    if (textTimerRef.current !== undefined) window.clearTimeout(textTimerRef.current);
    if (wheelTimerRef.current !== undefined) window.clearTimeout(wheelTimerRef.current);
    textTimerRef.current = undefined;
    wheelTimerRef.current = undefined;
    keyboardRef.current?.blur();
  }, [running, threadId]);

  useEffect(() => {
    if (!desktop) {
      setSessions([]);
      setActiveSessionId(null);
      setPreview(null);
      setAddress("");
      setLoading(false);
      return;
    }

    const expectedThreadId = threadId;
    const generation = ++loadGenerationRef.current;
    let disposed = false;
    setLoading(true);
    void listBrowserPanelSessions()
      .then(async (available) => {
        if (disposed || generation !== loadGenerationRef.current) return;
        const ownSessions = sortedSessions(available.filter((session) => (
          session.threadId === threadId
          || (session.id === sessionHint && !session.threadId)
        )));
        const preferred = ownSessions.find((session) => session.id === sessionHint)
          ?? ownSessions.find((session) => session.id === activeSessionIdRef.current)
          ?? ownSessions[0];
        setSessions(ownSessions);
        activeSessionIdRef.current = preferred?.id ?? null;
        setActiveSessionId(preferred?.id ?? null);
        setPreview((current) => current?.sessionId === preferred?.id ? current : null);
        if (!preferred) {
          setAddress("");
          setError(null);
          return;
        }
        const next = await getBrowserPanelPreview(preferred.id);
        if (
          disposed
          || generation !== loadGenerationRef.current
          || threadIdRef.current !== expectedThreadId
        ) return;
        applyPreview(next, expectedThreadId);
      })
      .catch((reason) => {
        if (!disposed && generation === loadGenerationRef.current) reportError(reason);
      })
      .finally(() => {
        if (!disposed && generation === loadGenerationRef.current && mountedRef.current) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [desktop, revision, sessionHint, threadId]);

  if (!desktop) {
    return (
      <div className="agent-browser-panel agent-browser-unavailable">
        <div className="agent-browser-empty">
          <span className="agent-browser-empty-icon"><Globe2 size={26} /></span>
          <strong>{tx("内置浏览器将在桌面端运行", "The built-in browser runs in the desktop app")}</strong>
          <span>{tx("这里不会用 iframe 模拟另一个会话。", "This preview does not imitate a separate session with an iframe.")}</span>
        </div>
      </div>
    );
  }

  const viewportMode = preview?.mobile ? "mobile" : "desktop";
  const pageTitle = preview?.title.trim() || preview?.url || tx("空白页", "Blank page");

  return (
    <div className={`agent-browser-panel${running ? " agent-running" : ""}${keyboardActive ? " keyboard-active" : ""}`}>
      <div className="agent-browser-session-bar">
        <Globe2 size={14} aria-hidden="true" />
        <select
          aria-label={tx("当前浏览器会话", "Current browser session")}
          title={tx("当前浏览器会话", "Current browser session")}
          value={activeSessionId ?? ""}
          disabled={sessions.length === 0}
          onChange={(event) => {
            const sessionId = event.target.value;
            loadGenerationRef.current += 1;
            activeSessionIdRef.current = sessionId || null;
            setActiveSessionId(sessionId);
            setPreview(null);
            const selected = sessions.find((session) => session.id === sessionId);
            setAddress(selected ? displayUrl(selected.url) : "");
            void loadPreview(sessionId);
          }}
        >
          {sessions.length === 0 && <option value="">{tx("暂无会话", "No sessions")}</option>}
          {sessions.map((session, index) => (
            <option value={session.id} title={session.url} key={session.id}>
              {sessionLabel(session, index)}
            </option>
          ))}
        </select>
        <span className={`agent-browser-run-state${running ? " active" : ""}`} role="status">
          <i aria-hidden="true" />
          {running ? tx("Agent 操作中", "Agent working") : tx("可交互", "Interactive")}
        </span>
        <IconButton
          className="agent-browser-new"
          label={tx("新建浏览器会话", "New browser session")}
          disabled={interactionsDisabled}
          onClick={() => void createSession(false)}
        >
          <Plus size={15} />
        </IconButton>
        <IconButton
          className="agent-browser-close-session"
          label={tx("关闭当前浏览器会话", "Close current browser session")}
          disabled={!activeSessionId || interactionsDisabled}
          onClick={() => void closeSession()}
        >
          <X size={15} />
        </IconButton>
      </div>

      <form className="agent-browser-navigation" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
        <div className="agent-browser-history-actions">
          <IconButton
            label={tx("后退", "Back")}
            disabled={!preview?.canGoBack || interactionsDisabled}
            onClick={() => activeSessionId && void enqueueCommand({ sessionId: activeSessionId, action: "back" })}
          ><ArrowLeft size={15} /></IconButton>
          <IconButton
            label={tx("前进", "Forward")}
            disabled={!preview?.canGoForward || interactionsDisabled}
            onClick={() => activeSessionId && void enqueueCommand({ sessionId: activeSessionId, action: "forward" })}
          ><ArrowRight size={15} /></IconButton>
          <IconButton
            label={tx("重新加载", "Reload")}
            disabled={!activeSessionId || interactionsDisabled}
            onClick={() => activeSessionId && void enqueueCommand({ sessionId: activeSessionId, action: "reload" })}
          ><RefreshCw size={14} /></IconButton>
        </div>
        <label className="agent-browser-address">
          <Globe2 size={13} aria-hidden="true" />
          <input
            aria-label={tx("网页地址", "Page address")}
            value={address}
            disabled={interactionsDisabled}
            placeholder="https://"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onFocus={() => { addressEditingRef.current = true; }}
            onBlur={() => { addressEditingRef.current = false; }}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="agent-browser-go"
          disabled={!address.trim() || interactionsDisabled}
          aria-label={activeSessionId ? tx("打开地址", "Open address") : tx("创建并打开", "Create and open")}
          title={activeSessionId ? tx("打开地址", "Open address") : tx("创建并打开", "Create and open")}
          onClick={(event) => {
            if (activeSessionId) return;
            event.preventDefault();
            void createSession(true);
          }}
        >
          <ArrowRight size={15} />
        </button>
      </form>

      <div className="agent-browser-view-options">
        <div className="agent-browser-viewport-switch" role="group" aria-label={tx("浏览器视口", "Browser viewport")}>
          <button
            type="button"
            className={viewportMode === "desktop" ? "active" : ""}
            aria-pressed={viewportMode === "desktop"}
            title={tx("桌面视口 1280 x 800", "Desktop viewport 1280 x 800")}
            disabled={!activeSessionId || interactionsDisabled}
            onClick={() => activeSessionId && void enqueueCommand({
              sessionId: activeSessionId,
              action: "setViewport",
              width: 1280,
              height: 800,
              mobile: false,
            })}
          ><Monitor size={13} /><span>1280 x 800</span></button>
          <button
            type="button"
            className={viewportMode === "mobile" ? "active" : ""}
            aria-pressed={viewportMode === "mobile"}
            title={tx("手机视口 390 x 844", "Mobile viewport 390 x 844")}
            disabled={!activeSessionId || interactionsDisabled}
            onClick={() => activeSessionId && void enqueueCommand({
              sessionId: activeSessionId,
              action: "setViewport",
              width: 390,
              height: 844,
              mobile: true,
            })}
          ><Smartphone size={13} /><span>390 x 844</span></button>
        </div>
        <IconButton
          className={`agent-browser-console-toggle${consoleOpen ? " active" : ""}`}
          label={consoleOpen ? tx("关闭控制台", "Close console") : tx("打开控制台", "Open console")}
          aria-expanded={consoleOpen}
          onClick={() => setConsoleOpen((open) => !open)}
        >
          <TerminalSquare size={14} />
          {Boolean(preview?.consoleErrorCount) && <small>{preview?.consoleErrorCount}</small>}
        </IconButton>
      </div>

      {error && (
        <button className="agent-browser-error" type="button" role="alert" onClick={() => setError(null)}>
          <CircleAlert size={14} /><span>{error}</span><X size={12} />
        </button>
      )}

      <div className="agent-browser-content">
        <div className="agent-browser-stage" aria-busy={loading || pendingOperations > 0}>
          {preview?.screenshotDataUrl ? (
            <div className="agent-browser-canvas" data-viewport={`${preview.viewportWidth}x${preview.viewportHeight}`}>
              <img
                ref={imageRef}
                src={preview.screenshotDataUrl}
                alt={tx(`${pageTitle} 的浏览器预览`, `Browser preview of ${pageTitle}`)}
                draggable={false}
                aria-disabled={interactionsDisabled}
                onClick={handleCanvasClick}
                onWheel={handleCanvasWheel}
              />
              <textarea
                ref={keyboardRef}
                className="agent-browser-keyboard-capture"
                aria-label={tx("向浏览器页面输入", "Type into browser page")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                defaultValue=""
                disabled={interactionsDisabled}
                onFocus={() => setKeyboardActive(true)}
                onBlur={() => setKeyboardActive(false)}
                onInput={handleKeyboardInput}
                onPaste={(event) => {
                  event.preventDefault();
                  enqueueText(event.clipboardData.getData("text"));
                }}
                onKeyDown={handleKeyboardKeyDown}
              />
              {running && <div className="agent-browser-agent-overlay"><LoaderCircle size={16} />{tx("Agent 正在操作浏览器", "Agent is operating the browser")}</div>}
            </div>
          ) : loading ? (
            <div className="agent-browser-empty"><LoaderCircle className="spin" size={23} /><span>{tx("正在读取浏览器", "Loading browser")}</span></div>
          ) : (
            <div className="agent-browser-empty">
              <span className="agent-browser-empty-icon"><Globe2 size={26} /></span>
              <strong>{tx("等待页面", "Waiting for a page")}</strong>
              <span>{tx("输入地址开始浏览，或等待 Agent 打开测试页面。", "Enter an address, or wait for the Agent to open a test page.")}</span>
              <button type="button" disabled={interactionsDisabled} onClick={() => void createSession(true)}>
                <Plus size={14} />{tx("打开浏览器", "Open browser")}
              </button>
            </div>
          )}
          {(loading || pendingOperations > 0) && preview && (
            <span className="agent-browser-progress" role="status"><LoaderCircle size={14} />{tx("正在更新", "Updating")}</span>
          )}
        </div>

        {consoleOpen && (
          <aside className="agent-browser-console" aria-label={tx("浏览器控制台", "Browser console")}>
            <header>
              <span><TerminalSquare size={13} /><strong>Console</strong></span>
              <small>{preview?.consoleEntries.length ?? 0}</small>
              <IconButton label={tx("关闭控制台", "Close console")} onClick={() => setConsoleOpen(false)}><X size={13} /></IconButton>
            </header>
            <div className="agent-browser-console-list" role="log" aria-live="polite">
              {preview?.consoleEntries.length ? preview.consoleEntries.map((entry, index) => (
                <div className={`agent-browser-console-entry ${entry.level}`} key={`${entry.timestamp}:${index}`}>
                  <time dateTime={new Date(entry.timestamp).toISOString()}>{consoleTime(entry.timestamp)}</time>
                  <b>{entry.level}</b>
                  <code>{entry.text}</code>
                </div>
              )) : <span className="agent-browser-console-empty">{tx("控制台暂无输出", "No console output")}</span>}
            </div>
          </aside>
        )}
      </div>

      {preview && (
        <footer className="agent-browser-statusbar">
          <span title={preview.url}>{preview.readyState === "complete" ? tx("已载入", "Loaded") : tx("载入中", "Loading")}</span>
          <span>{preview.viewportWidth} x {preview.viewportHeight}</span>
          <span title={preview.threadId ?? threadId}>{tx("隔离会话", "Isolated session")}</span>
        </footer>
      )}
    </div>
  );
}
