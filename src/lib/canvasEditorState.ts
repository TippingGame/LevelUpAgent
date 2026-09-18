export interface CanvasPoint { x: number; y: number }

export interface MaskStroke {
  id: string;
  tool: "mask" | "erase";
  width: number;
  points: CanvasPoint[];
}

export interface CanvasLabel {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface EditorSnapshot {
  strokes: MaskStroke[];
  labels: CanvasLabel[];
  padding: number;
}

export interface CanvasEditorState extends EditorSnapshot {
  sourceId: string;
}

/** Reopen against the original image, with a private copy of its editable layers. */
export function restoreCanvasEditorState(sourceId: string, saved?: CanvasEditorState): EditorSnapshot {
  return saved?.sourceId === sourceId
    ? structuredClone({ strokes: saved.strokes, labels: saved.labels, padding: saved.padding })
    : { strokes: [], labels: [], padding: 0 };
}
