import { useLayoutEffect, useRef, type RefObject } from "react";

export interface ConstellationEntrySnapshot {
  overview: HTMLElement;
  cover: HTMLElement;
  source: DOMRect;
  scrollTop: number;
  projectId?: string;
}

export function captureConstellationEntry(cover: HTMLElement): ConstellationEntrySnapshot | undefined {
  const overview = cover.closest<HTMLElement>(".constellation-overview");
  if (!overview || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  return {
    overview: overview.cloneNode(true) as HTMLElement,
    cover: cover.cloneNode(true) as HTMLElement,
    source: cover.getBoundingClientRect(),
    scrollTop: overview.scrollTop,
    projectId: cover.closest<HTMLElement>(".constellation-project-card")?.dataset.projectId,
  };
}

export function ConstellationEnterTransition({ snapshot, workbenchRef, onComplete }: {
  snapshot: ConstellationEntrySnapshot;
  workbenchRef: RefObject<HTMLDivElement | null>;
  onComplete: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const canvas = workbenchRef.current;
    if (!overlay || !canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onComplete(); return; }
    const bounds = canvas.getBoundingClientRect();
    const { overview, cover, source } = snapshot;
    const x = source.left - bounds.left;
    const y = source.top - bounds.top;
    const scale = source.width / Math.max(1, bounds.width);
    Object.assign(cover.style, { position: "absolute", left: "0", top: "0", width: `${source.width}px`, height: `${source.height}px`, margin: "0", transformOrigin: "0 0", willChange: "transform, opacity", pointerEvents: "none" });
    overview.classList.add("constellation-entry-overview");
    overview.querySelectorAll<HTMLElement>(".constellation-project-card").forEach((card) => {
      if (card.dataset.projectId === snapshot.projectId) card.querySelector<HTMLElement>(".constellation-project-cover")!.style.visibility = "hidden";
    });
    overlay.replaceChildren(overview, cover);
    overview.scrollTop = snapshot.scrollTop;
    const duration = 700;
    const easing = "cubic-bezier(.4, 0, .2, 1)";
    // The live canvas and thumbnail follow the same camera path during the crossfade.
    const canvasAnimation = canvas.animate([
      { transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: 0, transformOrigin: "0 0" },
      { opacity: 0, offset: .18 },
      { opacity: 1, offset: .72 },
      { transform: "translate(0, 0) scale(1)", opacity: 1, transformOrigin: "0 0" },
    ], { duration, easing, fill: "both" });
    const coverAnimation = cover.animate([
      { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1, borderRadius: "8px" },
      { opacity: 1, offset: .18 },
      { opacity: 0, offset: .75 },
      { transform: `translate(0, 0) scale(${1 / scale})`, opacity: 0, borderRadius: "0" },
    ], { duration, easing, fill: "both" });
    const backdropAnimation = overview.animate([{ opacity: 1 }, { opacity: 0, offset: .72 }, { opacity: 0 }], { duration, easing, fill: "both" });
    const introAnimation = overview.querySelector(".constellation-overview-intro")?.animate([
      { transform: "translateY(0)", opacity: 1 },
      { transform: "translateY(-64px)", opacity: 0 },
    ], { duration: 420, easing, fill: "both" });
    const animations = [canvasAnimation, coverAnimation, backdropAnimation, introAnimation];
    let disposed = false;
    void canvasAnimation.finished.then(() => {
      if (disposed) return;
      canvasAnimation.cancel();
      onComplete();
    }).catch(() => undefined);
    return () => { disposed = true; animations.forEach((animation) => animation?.cancel()); overlay.replaceChildren(); };
  }, [snapshot, workbenchRef, onComplete]);
  return <div ref={overlayRef} className="constellation-enter-transition" aria-hidden="true" inert />;
}
