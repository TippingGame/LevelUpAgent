import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Brush,
  Check,
  Eraser,
  Expand,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Redo2,
  Tag,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { importClipboardImages, previewAttachment } from "../lib/bridge";
import { tr } from "../lib/i18n";
import type { ImageAttachment } from "../lib/types";

type CanvasTool = "mask" | "erase" | "label" | "pan";

interface CanvasPoint {
  x: number;
  y: number;
}

interface MaskStroke {
  id: string;
  tool: "mask" | "erase";
  width: number;
  points: CanvasPoint[];
}

interface CanvasLabel {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

interface EditorSnapshot {
  strokes: MaskStroke[];
  labels: CanvasLabel[];
  padding: number;
}

interface CanvasPointerMapping {
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
}

interface ActiveMaskStroke {
  pointerId: number;
  stroke: MaskStroke;
  mapping: CanvasPointerMapping;
}

interface CanvasView {
  zoom: number;
  x: number;
  y: number;
}

interface CanvasPanGesture {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

export function ConstellationCanvasEditor({
  source,
  onClose,
  onSave,
}: {
  source: ImageAttachment;
  onClose: () => void;
  onSave: (image: ImageAttachment, mask?: ImageAttachment) => void;
}) {
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasStageRef = useRef<HTMLDivElement>(null);
  const canvasStackRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | undefined>(undefined);
  const activeStrokeRef = useRef<ActiveMaskStroke | undefined>(undefined);
  const panGestureRef = useRef<CanvasPanGesture | undefined>(undefined);
  const panFrameRef = useRef<number | null>(null);
  const pendingPanPointRef = useRef<CanvasPoint | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [tool, setTool] = useState<CanvasTool>("mask");
  const [brushSize, setBrushSize] = useState(42);
  const [labelText, setLabelText] = useState("主体");
  const [labelColor, setLabelColor] = useState("#fb7185");
  const [padding, setPadding] = useState(0);
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [labels, setLabels] = useState<CanvasLabel[]>([]);
  const [undoStack, setUndoStack] = useState<EditorSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorSnapshot[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<CanvasView>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  const [panning, setPanning] = useState(false);
  const onCloseRef = useRef(onClose);
  const keyboardActionsRef = useRef<{ undo: () => void; redo: () => void }>({
    undo: () => undefined,
    redo: () => undefined,
  });
  onCloseRef.current = onClose;

  const outputSize = useMemo(() => ({
    width: Math.max(1, Math.round(imageSize.width * (1 + padding * 2))),
    height: Math.max(1, Math.round(imageSize.height * (1 + padding * 2))),
    offsetX: Math.round(imageSize.width * padding),
    offsetY: Math.round(imageSize.height * padding),
  }), [imageSize.height, imageSize.width, padding]);

  useEffect(() => {
    let disposed = false;
    setSourceUrl(undefined);
    imageRef.current = undefined;
    activeStrokeRef.current = undefined;
    panGestureRef.current = undefined;
    pendingPanPointRef.current = null;
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
    setImageSize({ width: 0, height: 0 });
    setPadding(0);
    setStrokes([]);
    setLabels([]);
    setUndoStack([]);
    setRedoStack([]);
    setError(undefined);
    const resetView = { zoom: 1, x: 0, y: 0 };
    viewRef.current = resetView;
    setView(resetView);
    void previewAttachment(source).then((preview) => {
      if (!preview.dataBase64) throw new Error(tr("无法读取画板图片", "Could not read the canvas image"));
      if (!disposed) setSourceUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
    }).catch((reason) => {
      if (!disposed) setError(errorText(reason));
    });
    return () => { disposed = true; };
  }, [source.id]);

  useEffect(() => {
    if (!sourceUrl) return;
    let disposed = false;
    const image = new Image();
    image.onload = () => {
      if (disposed) return;
      imageRef.current = image;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      if (!disposed) setError(tr("图片解码失败", "The image could not be decoded"));
    };
    image.src = sourceUrl;
    return () => {
      disposed = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [sourceUrl]);

  useEffect(() => {
    viewRef.current = view;
    applyCanvasView(canvasStackRef.current, view);
  }, [view]);

  useEffect(() => () => {
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
  }, []);

  useEffect(() => {
    const canvas = imageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    const image = imageRef.current;
    if (!canvas || !maskCanvas || !image || outputSize.width <= 0 || outputSize.height <= 0) return;
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
    maskCanvas.width = outputSize.width;
    maskCanvas.height = outputSize.height;
    const context = canvas.getContext("2d");
    const maskContext = maskCanvas.getContext("2d");
    if (!context || !maskContext) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawCheckerboard(context, canvas.width, canvas.height);
    context.drawImage(image, outputSize.offsetX, outputSize.offsetY, imageSize.width, imageSize.height);
    drawLabels(context, labels);
    drawMaskLayer(maskContext, strokes, canvas.width, canvas.height, padding > 0 ? {
      x: outputSize.offsetX,
      y: outputSize.offsetY,
      width: imageSize.width,
      height: imageSize.height,
    } : undefined);
  }, [imageSize.height, imageSize.width, labels, outputSize, padding, strokes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) keyboardActionsRef.current.redo();
        else keyboardActionsRef.current.undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const snapshot = (): EditorSnapshot => ({
    strokes: structuredClone(strokes),
    labels: structuredClone(labels),
    padding,
  });

  const checkpoint = () => {
    setUndoStack((current) => [...current.slice(-39), snapshot()]);
    setRedoStack([]);
  };

  const restore = (value: EditorSnapshot) => {
    setStrokes(value.strokes);
    setLabels(value.labels);
    setPadding(value.padding);
  };

  const undo = () => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setRedoStack((current) => [...current.slice(-39), snapshot()]);
    setUndoStack((current) => current.slice(0, -1));
    restore(previous);
  };

  const redo = () => {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setUndoStack((current) => [...current.slice(-39), snapshot()]);
    setRedoStack((current) => current.slice(0, -1));
    restore(next);
  };
  keyboardActionsRef.current = { undo, redo };

  const pointerMapping = (canvas: HTMLCanvasElement): CanvasPointerMapping | null => {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      left: bounds.left,
      top: bounds.top,
      scaleX: canvas.width / bounds.width,
      scaleY: canvas.height / bounds.height,
    };
  };

  const pointFromClient = (clientX: number, clientY: number, mapping: CanvasPointerMapping) => ({
    x: (clientX - mapping.left) * mapping.scaleX,
    y: (clientY - mapping.top) * mapping.scaleY,
  });

  const appendActiveStrokePoint = (clientX: number, clientY: number) => {
    const active = activeStrokeRef.current;
    const context = maskCanvasRef.current?.getContext("2d");
    if (!active || !context) return;
    const point = pointFromClient(clientX, clientY, active.mapping);
    const previous = active.stroke.points[active.stroke.points.length - 1];
    if (previous && Math.abs(previous.x - point.x) < .01 && Math.abs(previous.y - point.y) < .01) return;
    active.stroke.points.push(point);
    drawMaskStrokeSegment(context, active.stroke, previous ?? point, point);
  };

  const constrainView = (candidate: CanvasView) => {
    const stack = canvasStackRef.current;
    const stage = canvasStageRef.current;
    if (!stack || !stage) return { ...candidate, x: 0, y: 0 };
    const availableWidth = Math.max(1, stage.clientWidth - 52);
    const availableHeight = Math.max(1, stage.clientHeight - 52);
    const maxX = Math.max(0, (stack.offsetWidth * candidate.zoom - availableWidth) / 2);
    const maxY = Math.max(0, (stack.offsetHeight * candidate.zoom - availableHeight) / 2);
    return {
      ...candidate,
      x: Math.min(maxX, Math.max(-maxX, candidate.x)),
      y: Math.min(maxY, Math.max(-maxY, candidate.y)),
    };
  };

  const commitView = (candidate: CanvasView) => {
    const next = constrainView(candidate);
    viewRef.current = next;
    applyCanvasView(canvasStackRef.current, next);
    setView(next);
  };

  const zoomCanvas = (requestedZoom: number, anchor?: CanvasPoint) => {
    const current = viewRef.current;
    const zoom = Math.min(4, Math.max(.5, requestedZoom));
    const ratio = zoom / current.zoom;
    const candidate = anchor ? {
      zoom,
      x: anchor.x - (anchor.x - current.x) * ratio,
      y: anchor.y - (anchor.y - current.y) * ratio,
    } : { ...current, zoom };
    commitView(candidate);
  };

  const fitCanvas = () => commitView({ zoom: 1, x: 0, y: 0 });

  const actualSizeCanvas = () => {
    const canvas = imageCanvasRef.current;
    const stack = canvasStackRef.current;
    if (!canvas || !stack || stack.offsetWidth <= 0 || stack.offsetHeight <= 0) return;
    const zoom = Math.min(4, Math.max(.5, Math.min(canvas.width / stack.offsetWidth, canvas.height / stack.offsetHeight)));
    commitView({ zoom, x: 0, y: 0 });
  };

  const updatePanPosition = (gesture: CanvasPanGesture, point: CanvasPoint) => {
    const current = viewRef.current;
    const next = constrainView({
      ...current,
      x: gesture.originX + point.x - gesture.startX,
      y: gesture.originY + point.y - gesture.startY,
    });
    viewRef.current = next;
    applyCanvasView(canvasStackRef.current, next);
  };

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const mapping = pointerMapping(event.currentTarget);
    if (!mapping) return;
    if (tool === "pan") {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const current = viewRef.current;
      panGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: current.x,
        originY: current.y,
      };
      setPanning(true);
      return;
    }
    const point = pointFromClient(event.clientX, event.clientY, mapping);
    event.currentTarget.setPointerCapture(event.pointerId);
    checkpoint();
    if (tool === "label") {
      const text = labelText.trim();
      if (!text) {
        setError(tr("请先输入标签文字", "Enter label text first"));
        return;
      }
      setLabels((current) => [...current, {
        id: crypto.randomUUID(),
        x: point.x,
        y: point.y,
        text: text.slice(0, 80),
        color: labelColor,
      }]);
      return;
    }
    const stroke: MaskStroke = {
      id: crypto.randomUUID(),
      tool,
      width: Math.max(2, brushSize * ((mapping.scaleX + mapping.scaleY) / 2)),
      points: [{ x: point.x, y: point.y }],
    };
    activeStrokeRef.current = { pointerId: event.pointerId, stroke, mapping };
    const context = maskCanvasRef.current?.getContext("2d");
    if (context) drawMaskStrokeSegment(context, stroke, point, point);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pan = panGestureRef.current;
    if (pan?.pointerId === event.pointerId) {
      event.preventDefault();
      pendingPanPointRef.current = { x: event.clientX, y: event.clientY };
      if (panFrameRef.current === null) {
        panFrameRef.current = window.requestAnimationFrame(() => {
          panFrameRef.current = null;
          const latestGesture = panGestureRef.current;
          const point = pendingPanPointRef.current;
          pendingPanPointRef.current = null;
          if (latestGesture && point) updatePanPosition(latestGesture, point);
        });
      }
      return;
    }
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    for (const sample of samples) appendActiveStrokePoint(sample.clientX, sample.clientY);
  };

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pan = panGestureRef.current;
    if (pan?.pointerId === event.pointerId) {
      if (panFrameRef.current !== null) {
        window.cancelAnimationFrame(panFrameRef.current);
        panFrameRef.current = null;
      }
      updatePanPosition(pan, { x: event.clientX, y: event.clientY });
      pendingPanPointRef.current = null;
      panGestureRef.current = undefined;
      setView({ ...viewRef.current });
      setPanning(false);
    }
    const active = activeStrokeRef.current;
    if (active?.pointerId === event.pointerId) {
      appendActiveStrokePoint(event.clientX, event.clientY);
      activeStrokeRef.current = undefined;
      setStrokes((current) => [...current, active.stroke]);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const wheelCanvas = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const stage = canvasStageRef.current;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const anchor = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
    zoomCanvas(viewRef.current.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), anchor);
  };

  const changePadding = (value: number) => {
    if (value === padding) return;
    checkpoint();
    const deltaX = Math.round(imageSize.width * value) - outputSize.offsetX;
    const deltaY = Math.round(imageSize.height * value) - outputSize.offsetY;
    setPadding(value);
    setStrokes((current) => current.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x + deltaX, y: point.y + deltaY })),
    })));
    setLabels((current) => current.map((label) => ({ ...label, x: label.x + deltaX, y: label.y + deltaY })));
  };

  const save = async () => {
    const image = imageRef.current;
    if (!image) return;
    setSaving(true);
    setError(undefined);
    try {
      const annotated = document.createElement("canvas");
      annotated.width = outputSize.width;
      annotated.height = outputSize.height;
      const annotatedContext = annotated.getContext("2d");
      if (!annotatedContext) throw new Error(tr("无法创建输出画布", "Could not create the output canvas"));
      annotatedContext.clearRect(0, 0, annotated.width, annotated.height);
      annotatedContext.drawImage(image, outputSize.offsetX, outputSize.offsetY, imageSize.width, imageSize.height);
      drawLabels(annotatedContext, labels);
      const imageBlob = await canvasBlob(annotated);
      const timestamp = Date.now();
      const files = [new File([imageBlob], `constellation-canvas-${timestamp}.png`, { type: "image/png" })];
      if (strokes.some((stroke) => stroke.tool === "mask") || padding > 0) {
        const mask = createMaskCanvas(outputSize.width, outputSize.height, strokes, padding > 0 ? {
          x: outputSize.offsetX,
          y: outputSize.offsetY,
          width: imageSize.width,
          height: imageSize.height,
        } : undefined);
        files.push(new File([await canvasBlob(mask)], `constellation-mask-${timestamp}.png`, { type: "image/png" }));
      }
      const imported = await importClipboardImages(files);
      if (!imported[0]) throw new Error(tr("画板结果未能保存到素材库", "The canvas result could not be saved"));
      onSave(imported[0], imported[1]);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="constellation-canvas-modal" role="dialog" aria-modal="true" aria-labelledby="constellation-canvas-title" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section>
        <header>
          <div><span><Brush size={17} /></span><div><strong id="constellation-canvas-title">{tr("星图画板", "Constellation Canvas")}</strong><small>{source.name} · {outputSize.width} × {outputSize.height}</small></div></div>
          <button type="button" onClick={onClose} aria-label={tr("关闭画板", "Close canvas")}><X size={18} /></button>
        </header>
        <div className="constellation-editor-toolbar" role="toolbar" aria-label={tr("画板工具", "Canvas tools")}>
          <div className="canvas-tool-group">
            {([
              ["pan", MousePointer2, tr("查看", "View")],
              ["mask", Brush, tr("蒙版", "Mask")],
              ["erase", Eraser, tr("擦除", "Erase")],
              ["label", Tag, tr("标签", "Label")],
            ] as const).map(([value, Icon, label]) => <button type="button" className={tool === value ? "active" : ""} aria-pressed={tool === value} title={label} onClick={() => setTool(value)} key={value}><Icon size={14} /><span>{label}</span></button>)}
          </div>
          {(tool === "mask" || tool === "erase") && <label className="canvas-brush-size"><span>{tr("笔刷", "Brush")}</span><input type="range" min="8" max="120" step="2" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><b>{brushSize}</b></label>}
          {tool === "label" && <div className="canvas-label-controls"><input value={labelText} maxLength={80} placeholder={tr("标签文字", "Label text")} onChange={(event) => setLabelText(event.target.value)} /><input type="color" value={labelColor} aria-label={tr("标签颜色", "Label color")} onChange={(event) => setLabelColor(event.target.value)} /></div>}
          <div className="canvas-expand-controls"><Expand size={13} /><span>{tr("扩边", "Expand")}</span>{[0, .1, .25, .5].map((value) => <button type="button" className={padding === value ? "active" : ""} onClick={() => changePadding(value)} key={value}>{value === 0 ? tr("无", "None") : `+${Math.round(value * 100)}%`}</button>)}</div>
          <div className="canvas-history-controls"><button type="button" onClick={() => zoomCanvas(viewRef.current.zoom / 1.2)} title={tr("缩小", "Zoom out")}><ZoomOut size={14} /></button><button type="button" onClick={fitCanvas} title={tr("适应窗口", "Fit to window")}><Maximize2 size={14} /></button><button type="button" onClick={() => zoomCanvas(viewRef.current.zoom * 1.2)} title={tr("放大", "Zoom in")}><ZoomIn size={14} /></button><button type="button" disabled={undoStack.length === 0} onClick={undo} title={`${tr("撤销", "Undo")} Ctrl+Z`}><Undo2 size={14} /></button><button type="button" disabled={redoStack.length === 0} onClick={redo} title={`${tr("重做", "Redo")} Ctrl+Shift+Z`}><Redo2 size={14} /></button></div>
        </div>
        <div ref={canvasStageRef} className={`constellation-canvas-stage tool-${tool}${panning ? " panning" : ""}`}>
          {!sourceUrl && !error && <div className="canvas-loading"><LoaderCircle className="spin" size={28} /><span>{tr("正在准备画板…", "Preparing canvas…")}</span></div>}
          <div ref={canvasStackRef} className="constellation-canvas-stack" style={{ transform: canvasViewTransform(view) }}>
            <canvas ref={imageCanvasRef} aria-hidden="true" />
            <canvas
              ref={maskCanvasRef}
              aria-label={tr("图片标注与蒙版画布", "Image annotation and mask canvas")}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={pointerUp}
              onLostPointerCapture={pointerUp}
              onWheel={wheelCanvas}
              onDoubleClick={() => { if (Math.abs(viewRef.current.zoom - 1) < .01) actualSizeCanvas(); else fitCanvas(); }}
            />
          </div>
        </div>
        <footer>
          <div>
            {error ? <span className="canvas-editor-error">{error}</span> : <span>{tr("红色区域会被模型重绘；扩边会自动生成透明外圈蒙版", "Red regions may be repainted; expansion creates an outer transparent mask")}</span>}
          </div>
          <button type="button" onClick={onClose}>{tr("取消", "Cancel")}</button>
          <button type="button" className="primary" disabled={saving || imageSize.width === 0} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{saving ? tr("正在保存", "Saving") : tr("保存到节点", "Save to node")}</button>
        </footer>
      </section>
    </div>
  );
}

function drawCheckerboard(context: CanvasRenderingContext2D, width: number, height: number) {
  const size = Math.max(12, Math.round(Math.min(width, height) / 48));
  context.fillStyle = "#e2e8f0";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#f8fafc";
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      if ((x / size + y / size) % 2 === 0) context.fillRect(x, y, size, size);
    }
  }
}

function canvasViewTransform(view: CanvasView) {
  return `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`;
}

function applyCanvasView(element: HTMLDivElement | null, view: CanvasView) {
  if (element) element.style.transform = canvasViewTransform(view);
}

function drawLabels(context: CanvasRenderingContext2D, labels: CanvasLabel[]) {
  for (const label of labels) {
    const fontSize = Math.max(18, Math.round(Math.min(context.canvas.width, context.canvas.height) / 36));
    context.font = `700 ${fontSize}px system-ui, sans-serif`;
    const padding = Math.max(8, fontSize * .42);
    const metrics = context.measureText(label.text);
    const width = metrics.width + padding * 2;
    const height = fontSize + padding * 1.5;
    const x = Math.min(context.canvas.width - width - 2, Math.max(2, label.x));
    const y = Math.min(context.canvas.height - height - 2, Math.max(height + 2, label.y));
    context.fillStyle = "rgba(15, 23, 42, .82)";
    roundedRect(context, x, y - height, width, height, padding * .65);
    context.fill();
    context.strokeStyle = label.color;
    context.lineWidth = Math.max(2, fontSize / 10);
    context.stroke();
    context.fillStyle = "#ffffff";
    context.textBaseline = "middle";
    context.fillText(label.text, x + padding, y - height / 2);
    context.beginPath();
    context.moveTo(x + padding, y);
    context.lineTo(x + padding * .45, y + padding);
    context.lineTo(x + padding * 1.45, y);
    context.fillStyle = label.color;
    context.fill();
  }
}

function drawStroke(context: CanvasRenderingContext2D, stroke: MaskStroke) {
  const first = stroke.points[0];
  if (!first) return;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.width;
  context.beginPath();
  context.moveTo(first.x, first.y);
  if (stroke.points.length === 1) context.lineTo(first.x + .01, first.y + .01);
  else for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
}

function drawMaskLayer(
  context: CanvasRenderingContext2D,
  strokes: MaskStroke[],
  width: number,
  height: number,
  preserved?: { x: number; y: number; width: number; height: number },
) {
  context.clearRect(0, 0, width, height);
  if (preserved) {
    context.fillStyle = "rgba(244, 63, 94, .34)";
    context.fillRect(0, 0, width, height);
    context.clearRect(preserved.x, preserved.y, preserved.width, preserved.height);
  }
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.tool === "mask" ? "source-over" : "destination-out";
    context.strokeStyle = "rgba(244, 63, 94, .48)";
    drawStroke(context, stroke);
  }
  context.globalCompositeOperation = "source-over";
}

function drawMaskStrokeSegment(
  context: CanvasRenderingContext2D,
  stroke: MaskStroke,
  from: CanvasPoint,
  to: CanvasPoint,
) {
  context.save();
  context.globalCompositeOperation = stroke.tool === "mask" ? "source-over" : "destination-out";
  context.strokeStyle = "rgba(244, 63, 94, .48)";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.width;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x + (from === to ? .01 : 0), to.y + (from === to ? .01 : 0));
  context.stroke();
  context.restore();
}

function createMaskCanvas(
  width: number,
  height: number,
  strokes: MaskStroke[],
  preserved?: { x: number; y: number; width: number; height: number },
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "rgba(0, 0, 0, 1)";
  if (preserved) context.fillRect(preserved.x, preserved.y, preserved.width, preserved.height);
  else context.fillRect(0, 0, width, height);
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.tool === "mask" ? "destination-out" : "source-over";
    context.strokeStyle = "rgba(0, 0, 0, 1)";
    drawStroke(context, stroke);
  }
  context.globalCompositeOperation = "source-over";
  return canvas;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error(tr("无法编码 PNG", "Could not encode PNG")));
  }, "image/png"));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
