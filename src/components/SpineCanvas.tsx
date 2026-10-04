import { useEffect, useMemo, useRef, useState } from "react";
import { loadSpineImage } from "../lib/spineAssets";
import {
  spinePartMesh,
  spineWorldPose,
  spineWorldVertices,
  type SpineClip,
  type SpinePart,
} from "../lib/spine";
import { SpineRenderer } from "../lib/spineRenderer";
import { tr } from "../lib/i18n";

export function SpineCanvas({
  parts,
  clip,
  time,
  selected,
  bones,
  mesh,
  zoom,
  setup,
  disabled,
  onSelect,
  onMove,
  onError,
}: {
  parts: SpinePart[];
  clip?: SpineClip;
  time: number;
  selected: string;
  bones: boolean;
  mesh: boolean;
  zoom: number;
  setup: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number, remember: boolean) => void;
  onError: (error: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    glCanvasRef = useRef<HTMLCanvasElement>(null),
    renderer = useRef<SpineRenderer | null>(null),
    hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 500 }),
    [images, setImages] = useState(new Map<string, HTMLImageElement>());
  const imageSources = useMemo(
    () => parts.map((p) => ({ id: p.id, image: p.image })),
    [parts],
  );
  const cache = useRef(
    new Map<string, { source: string; image: HTMLImageElement }>(),
  );
  const viewRef = useRef({ scale: 1, cx: 0, cy: 0 });
  const drag = useRef<{
    id: string;
    px: number;
    py: number;
    x: number;
    y: number;
    scale: number;
    cx: number;
    cy: number;
    moved: boolean;
  } | null>(null);
  useEffect(() => {
    const canvas = glCanvasRef.current;
    if (!canvas) return;
    const create = () => {
      try {
        renderer.current = new SpineRenderer(canvas);
        setImages((current) => new Map(current));
      } catch (e) {
        onError(String(e));
      }
    };
    const lost = (event: Event) => {
      event.preventDefault();
      renderer.current = null;
      onError(
        tr(
          "预览显卡上下文丢失，正在等待恢复。",
          "Preview graphics context was lost; waiting for recovery.",
        ),
      );
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", create);
    create();
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", create);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [onError]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    void Promise.all(
      imageSources.map(async (p) => {
        const existing = cache.current.get(p.id);
        return [
          p.id,
          existing?.source === p.image
            ? existing.image
            : await loadSpineImage(p.image),
        ] as const;
      }),
    )
      .then((loaded) => {
        if (disposed) return;
        cache.current = new Map(
          loaded.map(([id, image]) => [
            id,
            { source: imageSources.find((p) => p.id === id)!.image, image },
          ]),
        );
        setImages(new Map(loaded));
      })
      .catch((e) => {
        if (!disposed) onError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [imageSources, onError]);
  const meshes = useMemo(
    () => new Map(parts.map((p) => [p.id, spinePartMesh(p)])),
    [parts],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width < 1 || size.height < 1) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    for (const surface of [canvas, glCanvasRef.current])
      if (surface) {
        const width = Math.round(size.width * ratio),
          height = Math.round(size.height * ratio);
        if (surface.width !== width) surface.width = width;
        if (surface.height !== height) surface.height = height;
      }
    const c = canvas.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.scale(ratio, ratio);
    const minX = parts.length
      ? Math.min(...parts.map((p) => p.x - p.width * p.pivotX))
      : -200;
    const maxX = parts.length
      ? Math.max(...parts.map((p) => p.x + p.width * (1 - p.pivotX)))
      : 200;
    const minY = parts.length
      ? Math.min(...parts.map((p) => p.y - p.height * (1 - p.pivotY)))
      : -240;
    const maxY = parts.length
      ? Math.max(...parts.map((p) => p.y + p.height * p.pivotY))
      : 240;
    const scale =
      drag.current?.scale ??
      Math.max(
        0.01,
        Math.min(
          size.width / (maxX - minX + 160),
          size.height / (maxY - minY + 130),
        ) * zoom,
      );
    const cx = drag.current?.cx ?? size.width / 2 - ((minX + maxX) / 2) * scale,
      cy = drag.current?.cy ?? size.height / 2 + ((minY + maxY) / 2) * scale;
    viewRef.current = { scale, cx, cy };
    c.translate(cx, cy);
    c.scale(scale, -scale);
    renderer.current?.begin(
      size.width,
      size.height,
      scale,
      cx,
      cy,
      parts.map((p) => p.id),
    );
    const pose = spineWorldPose(parts, setup ? undefined : clip, time);
    for (const part of parts) {
      const image = images.get(part.id),
        geometry = meshes.get(part.id)!;
      const vertices = spineWorldVertices(part, pose, geometry);
      if (image)
        renderer.current?.draw(
          part.id,
          image,
          vertices,
          geometry.uvs,
          geometry.triangles,
        );
      if (mesh && part.id === selected) {
        c.strokeStyle = "#69e0df";
        c.lineWidth = 0.8 / scale;
        for (let i = 0; i < geometry.triangles.length; i += 3) {
          c.beginPath();
          for (let j = 0; j < 3; j++) {
            const index = geometry.triangles[i + j];
            if (j === 0) c.moveTo(vertices[index * 2], vertices[index * 2 + 1]);
            else c.lineTo(vertices[index * 2], vertices[index * 2 + 1]);
          }
          c.closePath();
          c.stroke();
        }
      }
    }
    if (bones)
      for (const part of parts) {
        const base = pose.get(part.id)!,
          tip = pose.get(`${part.id}_bend`)!;
        c.strokeStyle = part.id === selected ? "#fff0a2" : "#89cafa";
        c.fillStyle = c.strokeStyle;
        c.lineWidth = 2 / scale;
        c.beginPath();
        c.moveTo(base.x, base.y);
        c.lineTo(tip.x, tip.y);
        c.stroke();
        c.beginPath();
        c.arc(base.x, base.y, 5 / scale, 0, Math.PI * 2);
        c.fill();
        if (part.parent) {
          const parent = pose.get(part.parent)!;
          c.save();
          c.globalAlpha = 0.35;
          c.setLineDash([4 / scale, 4 / scale]);
          c.beginPath();
          c.moveTo(base.x, base.y);
          c.lineTo(parent.x, parent.y);
          c.stroke();
          c.restore();
        }
      }
  }, [
    parts,
    clip,
    time,
    images,
    size,
    bones,
    mesh,
    zoom,
    setup,
    selected,
    meshes,
  ]);
  return (
    <div ref={hostRef} className="spine-canvas-host">
      <canvas
        ref={glCanvasRef}
        aria-hidden="true"
        className="spine-mesh-canvas"
      />
      <canvas
        ref={canvasRef}
        aria-label={tr(
          "Spine 动画预览，选择部件后可在绑定姿势中拖动",
          "Spine animation preview; drag parts in setup pose",
        )}
        onPointerDown={(event) => {
          if (disabled) return;
          const rect = event.currentTarget.getBoundingClientRect(),
            v = viewRef.current;
          const x = (event.clientX - rect.left - v.cx) / v.scale,
            y = -(event.clientY - rect.top - v.cy) / v.scale;
          const pose = spineWorldPose(parts, setup ? undefined : clip, time);
          const nearest = [...parts].reverse().find((p) => {
            const vertices = spineWorldVertices(p, pose, meshes.get(p.id)!);
            for (let i = 0; i < meshes.get(p.id)!.triangles.length; i += 3) {
              const ids = meshes.get(p.id)!.triangles.slice(i, i + 3),
                pts = ids.map((n) => [vertices[n * 2], vertices[n * 2 + 1]]);
              const cross = pts.map((a, j) => {
                const b = pts[(j + 1) % 3];
                return (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
              });
              if (cross.every((n) => n >= 0) || cross.every((n) => n <= 0))
                return true;
            }
            return false;
          });
          if (!nearest) return;
          onSelect(nearest.id);
          if (setup) {
            drag.current = {
              id: nearest.id,
              px: event.clientX,
              py: event.clientY,
              x: nearest.x,
              y: nearest.y,
              ...v,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          if (!drag.current || disabled) return;
          const d = drag.current;
          onMove(
            d.id,
            d.x + (event.clientX - d.px) / d.scale,
            d.y - (event.clientY - d.py) / d.scale,
            !d.moved,
          );
          d.moved = true;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
    </div>
  );
}
