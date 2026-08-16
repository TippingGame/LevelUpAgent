import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, PhysicalPosition } from "@tauri-apps/api/dpi";
import { BookOpen, CheckCircle2, ChevronRight, CircleAlert, Coffee, Footprints, LoaderCircle, Moon, Sparkles } from "lucide-react";
import { getPixelAlignedPetSize, PetSprite, type PetSpriteState } from "./components/PetSprite";
import {
  getPetRuntime,
  bondWithPet,
  isDesktop,
  openCompletedTask,
  openPetChat,
  openPetWorkspace,
  respondToPetPrompt,
  setPetWindowPosition,
} from "./lib/bridge";
import { getAppLocale } from "./lib/i18n";
import {
  normalizedWindowPosition,
  patrolTarget,
  petBehaviorLabel,
  petBehaviorMessage,
  petBehaviorSprite,
  restoredWindowPosition,
} from "./lib/petAutonomy";
import type { PetActivity, PetDashboard } from "./lib/types";
import "./PetOverlay.css";

interface PetDragState {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  lastScreenX: number;
  windowX: number;
  windowY: number;
  ready: boolean;
  moved: boolean;
}

type PetOverlayStyle = CSSProperties & Record<`--${string}`, string | number>;
const PET_DRAG_DIRECTION_THRESHOLD_PX = 2;

interface AutonomousMove {
  frameId: number | null;
  cancelled: boolean;
  returnHome?: { x: number; y: number };
}

export function PetOverlay() {
  const [dashboard, setDashboard] = useState<PetDashboard | null>(null);
  const [activities, setActivities] = useState<PetActivity[]>([]);
  const [reaction, setReaction] = useState<PetSpriteState | null>(null);
  const [dragDirection, setDragDirection] = useState<"running-left" | "running-right" | null>(null);
  const [autonomousDirection, setAutonomousDirection] = useState<"running-left" | "running-right" | null>(null);
  const [positionReadyPetId, setPositionReadyPetId] = useState<string | null>(null);
  const [promptBusy, setPromptBusy] = useState<string | null>(null);
  const [completionBusy, setCompletionBusy] = useState(false);
  const dragRef = useRef<PetDragState | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<LogicalPosition | null>(null);
  const suppressClickRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const lastLevelRef = useRef<number | null>(null);
  const lastCompletionAtRef = useRef(0);
  const autonomousMoveRef = useRef<AutonomousMove | null>(null);
  const lastAutonomousMoveKeyRef = useRef<string | null>(null);
  const locale = getAppLocale();
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const activePet = dashboard?.pets.find((pet) => pet.id === dashboard.activePetId) ?? dashboard?.pets[0];
  const activeActivities = useMemo(
    () => activities.filter((activity) => activity.state !== "completed"),
    [activities],
  );
  const completionActivities = useMemo(
    () => activities
      .filter((activity) => activity.state === "completed" && activity.threadId)
      .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0)),
    [activities],
  );
  const latestCompletion = completionActivities[0];

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const runtime = await getPetRuntime();
        if (!disposed) {
          setDashboard(runtime.dashboard);
          setActivities(runtime.activities);
        }
      } catch {
        if (!disposed) setReaction("failed");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const listeners = isDesktop()
      ? Promise.all([
          listen<PetDashboard>("pet://refresh", (event) => setDashboard(event.payload)),
          listen<PetActivity[]>("pet://activities", (event) => setActivities(event.payload)),
        ])
      : Promise.resolve([]);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
      const autonomousMove = autonomousMoveRef.current;
      if (autonomousMove) {
        autonomousMove.cancelled = true;
        if (autonomousMove.frameId !== null) window.cancelAnimationFrame(autonomousMove.frameId);
      }
      void listeners.then((unlisten) => unlisten.forEach((stop) => stop()));
    };
  }, []);

  const workState = useMemo<PetSpriteState>(() => {
    if (activeActivities.some((item) => item.state === "waiting")) return "waiting";
    if (activeActivities.some((item) => item.state === "generating")) return "running";
    if (activeActivities.length > 0) return "review";
    return "idle";
  }, [activeActivities]);

  useEffect(() => {
    const completedAt = latestCompletion?.completedAt ?? 0;
    if (completedAt > lastCompletionAtRef.current) setReaction("jumping");
    lastCompletionAtRef.current = Math.max(lastCompletionAtRef.current, completedAt);
  }, [latestCompletion?.completedAt]);

  useEffect(() => {
    if (!dashboard) return;
    if (lastLevelRef.current !== null && dashboard.progress.level > lastLevelRef.current) {
      setReaction("jumping");
    }
    lastLevelRef.current = dashboard.progress.level;
  }, [dashboard?.progress.level]);

  useEffect(() => {
    if (!isDesktop() || !dashboard || !activePet) return;
    let disposed = false;
    setPositionReadyPetId(null);
    const restore = async () => {
      const petWindow = getCurrentWindow();
      const saved = dashboard.life.windowPosition;
      if (saved) {
        const [monitor, size] = await Promise.all([currentMonitor(), petWindow.outerSize()]);
        if (monitor && !disposed) {
          const target = restoredWindowPosition(saved, {
            x: monitor.workArea.position.x,
            y: monitor.workArea.position.y,
            width: monitor.workArea.size.width,
            height: monitor.workArea.size.height,
          }, { x: size.width, y: size.height });
          await petWindow.setPosition(new PhysicalPosition(Math.round(target.x), Math.round(target.y)));
        }
      }
      if (!disposed) setPositionReadyPetId(activePet.id);
    };
    void restore().catch(() => {
      if (!disposed) setPositionReadyPetId(activePet.id);
    });
    return () => { disposed = true; };
  }, [activePet?.id]);

  useEffect(() => {
    if (!isDesktop() || !dashboard || !activePet) return;
    const behavior = dashboard.life.behavior;
    const canMove = positionReadyPetId === activePet.id
      && dashboard.life.settings.autonomyEnabled
      && dashboard.life.settings.movementEnabled
      && (behavior.state === "wandering" || behavior.reason.startsWith("study-supervision-"))
      && activities.length === 0;
    const moveKey = `${activePet.id}:${behavior.since}`;
    if (!canMove || lastAutonomousMoveKeyRef.current === moveKey) return;
    lastAutonomousMoveKeyRef.current = moveKey;
    const move: AutonomousMove = { frameId: null, cancelled: false };
    autonomousMoveRef.current = move;
    const begin = async () => {
      const petWindow = getCurrentWindow();
      const [monitor, position, size] = await Promise.all([
        currentMonitor(),
        petWindow.outerPosition(),
        petWindow.outerSize(),
      ]);
      if (!monitor || move.cancelled || dragRef.current) return;
      const workArea = {
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y,
        width: monitor.workArea.size.width,
        height: monitor.workArea.size.height,
      };
      const windowSize = { x: size.width, y: size.height };
      const start = { x: position.x, y: position.y };
      let direction: "left" | "right" = behavior.direction === "left" ? "left" : "right";
      let target = patrolTarget(start, workArea, windowSize, direction);
      if (Math.abs(target.x - start.x) < 24) {
        direction = direction === "left" ? "right" : "left";
        target = patrolTarget(start, workArea, windowSize, direction);
      }
      if (Math.abs(target.x - start.x) < 2) return;
      setAutonomousDirection(direction === "left" ? "running-left" : "running-right");
      const supervisionPatrol = behavior.reason.startsWith("study-supervision-");
      if (supervisionPatrol) move.returnHome = normalizedWindowPosition(start, workArea, windowSize);
      const distance = Math.abs(target.x - start.x);
      const speed = 105 * dashboard.life.settings.patrolSpeed * monitor.scaleFactor;
      const duration = Math.max(1_200, Math.min(12_000, distance / Math.max(1, speed) * 1_000));
      const stop = () => {
        move.cancelled = true;
        move.frameId = null;
        setAutonomousDirection(null);
      };
      const runLeg = (
        from: { x: number; y: number },
        to: { x: number; y: number },
        legDuration: number,
        onArrive: () => void,
      ) => {
        const startedAt = performance.now();
        const step = (time: number) => {
          move.frameId = null;
          if (move.cancelled || dragRef.current) return;
          const progress = Math.min(1, (time - startedAt) / legDuration);
          const x = from.x + (to.x - from.x) * progress;
          const y = from.y + (to.y - from.y) * progress;
          void petWindow
            .setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
            .then(() => {
              if (move.cancelled || dragRef.current) return;
              if (progress >= 1) {
                onArrive();
                return;
              }
              move.frameId = window.requestAnimationFrame(step);
            })
            .catch(stop);
        };
        move.frameId = window.requestAnimationFrame(step);
      };
      runLeg(start, target, duration, () => {
        setAutonomousDirection(null);
        if (move.returnHome && supervisionPatrol && !move.cancelled && !dragRef.current) {
          const home = restoredWindowPosition(move.returnHome, workArea, windowSize);
          setAutonomousDirection(home.x < target.x ? "running-left" : "running-right");
          const returnDistance = Math.hypot(home.x - target.x, home.y - target.y);
          const returnDuration = Math.max(1_200, Math.min(12_000, returnDistance / Math.max(1, speed) * 1_000));
          runLeg(target, home, returnDuration, () => {
            setAutonomousDirection(null);
            if (autonomousMoveRef.current === move) autonomousMoveRef.current = null;
          });
          return;
        }
        const relative = normalizedWindowPosition(target, workArea, windowSize);
        void setPetWindowPosition(activePet.id, relative.x, relative.y);
        if (autonomousMoveRef.current === move) autonomousMoveRef.current = null;
      });
    };
    void begin().catch(() => setAutonomousDirection(null));
    return () => {
      move.cancelled = true;
      if (move.frameId !== null) window.cancelAnimationFrame(move.frameId);
      if (autonomousMoveRef.current === move) autonomousMoveRef.current = null;
      setAutonomousDirection(null);
    };
  }, [
    activePet?.id,
    activities.length,
    dashboard?.life.behavior.since,
    dashboard?.life.behavior.state,
    dashboard?.life.behavior.reason,
    dashboard?.life.behavior.direction,
    dashboard?.life.settings.autonomyEnabled,
    dashboard?.life.settings.movementEnabled,
    dashboard?.life.settings.patrolSpeed,
    positionReadyPetId,
  ]);

  if (!dashboard || !activePet) return null;

  const handlePetClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      setReaction("waving");
      void bondWithPet(activePet.id).then(setDashboard).catch(() => undefined);
    }, 360);
  };

  const openConversation = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    void openPetChat(activePet.id).catch(() => setReaction("failed"));
  };

  const openWorkspace = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    void openPetWorkspace(activePet.id, "life").catch(() => setReaction("failed"));
  };

  const respondToPrompt = async (action: string) => {
    const prompt = dashboard.life.prompt;
    if (!prompt || promptBusy) return;
    setPromptBusy(action);
    try {
      if (prompt.kind === "task-reminder" && action === "open") {
        await openPetWorkspace(activePet.id, "plan");
      }
      const next = await respondToPetPrompt(activePet.id, prompt.id, action);
      setDashboard(next);
      if (action === "start") setReaction("waving");
    } catch {
      setReaction("failed");
      try {
        const runtime = await getPetRuntime();
        setDashboard(runtime.dashboard);
      } catch {
        // A stale reminder is harmless; the next regular refresh will reconcile it.
      }
    } finally {
      setPromptBusy(null);
    }
  };

  const openLatestCompletion = async () => {
    if (!latestCompletion?.threadId || completionBusy) return;
    setCompletionBusy(true);
    try {
      await openCompletedTask(latestCompletion.threadId);
    } catch {
      setReaction("failed");
    } finally {
      setCompletionBusy(false);
    }
  };

  const beginPetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isDesktop() || event.button !== 0) return;
    if (autonomousMoveRef.current) {
      autonomousMoveRef.current.cancelled = true;
      if (autonomousMoveRef.current.frameId !== null) {
        window.cancelAnimationFrame(autonomousMoveRef.current.frameId);
      }
      autonomousMoveRef.current = null;
      setAutonomousDirection(null);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag: PetDragState = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      lastScreenX: event.screenX,
      windowX: 0,
      windowY: 0,
      ready: false,
      moved: false,
    };
    dragRef.current = drag;
    const petWindow = getCurrentWindow();
    void Promise.all([petWindow.outerPosition(), petWindow.scaleFactor()]).then(([position, scaleFactor]) => {
      if (dragRef.current !== drag) return;
      const logical = position.toLogical(scaleFactor);
      drag.windowX = logical.x;
      drag.windowY = logical.y;
      drag.ready = true;
    });
  };

  const movePet = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !drag.ready) return;
    const deltaX = event.screenX - drag.startScreenX;
    const deltaY = event.screenY - drag.startScreenY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    suppressClickRef.current = true;
    const directionDeltaX = event.screenX - drag.lastScreenX;
    if (Math.abs(directionDeltaX) >= PET_DRAG_DIRECTION_THRESHOLD_PX) {
      setDragDirection(directionDeltaX < 0 ? "running-left" : "running-right");
      drag.lastScreenX = event.screenX;
    }
    pendingPositionRef.current = new LogicalPosition(
      Math.round(drag.windowX + deltaX),
      Math.round(drag.windowY + deltaY),
    );
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const position = pendingPositionRef.current;
      pendingPositionRef.current = null;
      if (position) void getCurrentWindow().setPosition(position);
    });
  };

  const endPetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragDirection(null);
    if (drag.moved) {
      setReaction("jumping");
      window.setTimeout(() => { suppressClickRef.current = false; }, 80);
      void persistCurrentWindowPosition(activePet.id);
    }
  };

  const lifeSpriteState = autonomousDirection
    ?? (dashboard.life.behavior.state === "wandering" ? "idle" : petBehaviorSprite(dashboard.life.behavior));
  const activeState = dragDirection ?? reaction ?? (activeActivities.length > 0 ? workState : lifeSpriteState);
  const scale = Math.min(1.45, Math.max(0.55, dashboard.scale || 0.75));
  const spriteSize = getPixelAlignedPetSize(scale);
  const overlayStyle: PetOverlayStyle = {
    "--pet-character-width": `${spriteSize.width}px`,
    "--pet-character-height": `${spriteSize.height}px`,
    "--pet-head-offset": `${42 + spriteSize.height - 8}px`,
  };

  return (
    <main className="pet-overlay" style={overlayStyle}>
      <div className="pet-overlay-activities" aria-live="polite">
        {dashboard.life.prompt && (
          <article className={`pet-overlay-prompt ${dashboard.life.prompt.tier ?? dashboard.life.prompt.kind}`}>
            <span><CircleAlert size={13} /></span>
            <div><strong>{promptTitle(dashboard.life.prompt.kind, dashboard.life.prompt.tier, locale)}</strong><small>{petPromptMessage(dashboard.life.prompt.message, dashboard.life.prompt.kind, dashboard.life.prompt.tier, locale)}</small></div>
            <footer>
              {dashboard.life.prompt.actions.map((action) => (
                <button type="button" disabled={promptBusy !== null} onClick={() => void respondToPrompt(action)} key={action}>
                  {promptBusy === action ? <LoaderCircle className="spin" size={10} /> : promptActionLabel(action, locale)}
                </button>
              ))}
            </footer>
          </article>
        )}
        {activeActivities.slice(0, dashboard.life.prompt ? 2 : 4).map((activity) => (
          <article className={activity.state} key={activity.id}>
            <span>{activity.state === "generating" ? <Sparkles size={13} /> : activity.state === "waiting" ? <CircleAlert size={13} /> : <LoaderCircle className="spin" size={13} />}</span>
            <div><strong>{activity.title}</strong><small>{activity.detail}</small></div>
          </article>
        ))}
        {activeActivities.length > (dashboard.life.prompt ? 2 : 4) && <b className="pet-overlay-more">+{activeActivities.length - (dashboard.life.prompt ? 2 : 4)}</b>}
        {activeActivities.length === 0 && completionActivities.length === 0 && !dashboard.life.prompt && dashboard.life.behavior.state !== "idle" && (
          <article className={`pet-overlay-thought ${dashboard.life.behavior.state}`}>
            <span>{behaviorIcon(dashboard.life.behavior.state)}</span>
            <div><strong>{petBehaviorLabel(dashboard.life.behavior.state, locale)}</strong><small>{petBehaviorMessage(dashboard.life.behavior, locale)}</small></div>
          </article>
        )}
        {latestCompletion && (
          <button
            className={`pet-overlay-completion${latestCompletion.unread ? " unread" : ""}`}
            type="button"
            aria-label={text(
              `${latestCompletion.title} 已完成，打开会话`,
              `${latestCompletion.title} completed, open conversation`,
            )}
            disabled={completionBusy}
            onClick={() => void openLatestCompletion()}
          >
            <span><CheckCircle2 size={15} /></span>
            <div><strong>{latestCompletion.title}</strong><small>{latestCompletion.unread ? text("任务已完成 · 点击查看", "Task completed · Click to view") : latestCompletion.detail}</small></div>
            {completionActivities.length > 1 && <b>{completionActivities.length > 99 ? "99+" : completionActivities.length}</b>}
            {completionBusy ? <LoaderCircle className="spin" size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
      </div>
      <button
        className="pet-overlay-character"
        type="button"
        aria-label={text(`打开 ${activePet.displayName} 的会话`, `Open ${activePet.displayName}'s conversation`)}
        onClick={handlePetClick}
        onDoubleClick={openConversation}
        onContextMenu={openWorkspace}
        onPointerDown={beginPetDrag}
        onPointerMove={movePet}
        onPointerUp={endPetDrag}
        onPointerCancel={endPetDrag}
      >
        <PetSprite
          profile={activePet}
          state={activeState}
          scale={scale}
          loop={!reaction || activeState !== reaction}
          onComplete={(completed) => setReaction((current) => current === completed ? null : current)}
        />
      </button>
      <div className="pet-overlay-status">
        <span><strong>{activePet.displayName}</strong><small>Lv.{dashboard.progress.level} · {petBehaviorLabel(dashboard.life.behavior.state, locale)}</small></span>
        <i><b style={{ width: `${Math.round(dashboard.progress.progress * 100)}%` }} /></i>
      </div>
    </main>
  );
}

async function persistCurrentWindowPosition(petId: string) {
  const petWindow = getCurrentWindow();
  const [monitor, position, size] = await Promise.all([
    currentMonitor(),
    petWindow.outerPosition(),
    petWindow.outerSize(),
  ]);
  if (!monitor) return;
  const relative = normalizedWindowPosition(position, {
    x: monitor.workArea.position.x,
    y: monitor.workArea.position.y,
    width: monitor.workArea.size.width,
    height: monitor.workArea.size.height,
  }, { x: size.width, y: size.height });
  await setPetWindowPosition(petId, relative.x, relative.y);
}

function behaviorIcon(state: string) {
  if (state === "wandering") return <Footprints size={13} />;
  if (state === "studying" || state === "learning" || state === "planning") return <BookOpen size={13} />;
  if (state === "sleeping") return <Moon size={13} />;
  if (state === "resting") return <Coffee size={13} />;
  if (state === "waiting") return <CircleAlert size={13} />;
  return <Sparkles size={13} />;
}

function promptTitle(kind: string, tier: string | undefined, locale: string) {
  if (kind === "check-in") return locale === "zh-CN" ? "我来见你了" : "I came to see you";
  if (kind === "task-reminder") return locale === "zh-CN" ? "今日约定" : "Today's promises";
  const labels: Record<string, [string, string]> = {
    playful: ["一起开始", "Begin together"],
    firm: ["认真提醒", "A serious reminder"],
    angry: ["别再拖延", "No more delay"],
    final: ["最后提醒", "Final reminder"],
  };
  const label = labels[tier ?? "playful"] ?? labels.playful;
  return locale === "zh-CN" ? label[0] : label[1];
}

function petPromptMessage(message: string, kind: string, tier: string | undefined, locale: string) {
  if (locale !== "zh-CN") return message;
  if (kind === "check-in") return "到我们约好的签到时间了。让我知道你在这里。";
  if (kind === "task-reminder") return "今天还有约定没有收好。要一起看一眼吗？";
  const messages: Record<string, string> = {
    playful: "从很小的一步开始，好吗？打开第一件事，我陪你一起进入状态。",
    firm: "我认真提醒你了。先选一件小事开始，我会一直陪着。",
    angry: "我们已经让这一段等太久了。现在打开第一件事，把时间拿回来。",
    final: "这是这一时段最后一次提醒。现在开始，或者明确告诉我这一段先放下。",
  };
  return messages[tier ?? "playful"] ?? message;
}

function promptActionLabel(action: string, locale: string) {
  const labels: Record<string, [string, string]> = {
    "check-in": ["我在", "I'm here"],
    start: ["现在开始", "Start"],
    snooze: ["10 分钟后", "10 min"],
    skip: ["本段跳过", "Skip"],
    open: ["查看", "Open"],
    dismiss: ["知道了", "Dismiss"],
  };
  const label = labels[action] ?? [action, action];
  return locale === "zh-CN" ? label[0] : label[1];
}
