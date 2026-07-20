import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { getPixelAlignedPetSize, PetSprite, type PetSpriteState } from "./components/PetSprite";
import { getPetRuntime, isDesktop, openPetChat } from "./lib/bridge";
import { getAppLocale } from "./lib/i18n";
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

export function PetOverlay() {
  const [dashboard, setDashboard] = useState<PetDashboard | null>(null);
  const [activities, setActivities] = useState<PetActivity[]>([]);
  const [reaction, setReaction] = useState<PetSpriteState | null>(null);
  const [dragDirection, setDragDirection] = useState<"running-left" | "running-right" | null>(null);
  const dragRef = useRef<PetDragState | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<LogicalPosition | null>(null);
  const suppressClickRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const lastLevelRef = useRef<number | null>(null);
  const locale = getAppLocale();
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;

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
      void listeners.then((unlisten) => unlisten.forEach((stop) => stop()));
    };
  }, []);

  const activePet = dashboard?.pets.find((pet) => pet.id === dashboard.activePetId) ?? dashboard?.pets[0];
  const workState = useMemo<PetSpriteState>(() => {
    if (activities.some((item) => item.state === "waiting")) return "waiting";
    if (activities.some((item) => item.state === "generating")) return "running";
    if (activities.length > 0) return "review";
    return "idle";
  }, [activities]);

  useEffect(() => {
    if (!dashboard) return;
    if (lastLevelRef.current !== null && dashboard.progress.level > lastLevelRef.current) {
      setReaction("jumping");
    }
    lastLevelRef.current = dashboard.progress.level;
  }, [dashboard?.progress.level]);

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
    }, 360);
  };

  const openConversation = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    void openPetChat(activePet.id).catch(() => setReaction("failed"));
  };

  const beginPetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isDesktop() || event.button !== 0) return;
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
    }
  };

  const activeState = dragDirection ?? reaction ?? workState;
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
        {activities.slice(0, 4).map((activity) => (
          <article className={activity.state} key={activity.id}>
            <span>{activity.state === "generating" ? <Sparkles size={13} /> : activity.state === "waiting" ? <CircleAlert size={13} /> : <LoaderCircle className="spin" size={13} />}</span>
            <div><strong>{activity.title}</strong><small>{activity.detail}</small></div>
          </article>
        ))}
        {activities.length > 4 && <b className="pet-overlay-more">+{activities.length - 4}</b>}
      </div>
      <button
        className="pet-overlay-character"
        type="button"
        aria-label={text(`打开 ${activePet.displayName} 的会话`, `Open ${activePet.displayName}'s conversation`)}
        onClick={handlePetClick}
        onDoubleClick={openConversation}
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
        <span><strong>{activePet.displayName}</strong><small>Lv.{dashboard.progress.level}</small></span>
        <i><b style={{ width: `${Math.round(dashboard.progress.progress * 100)}%` }} /></i>
      </div>
    </main>
  );
}
