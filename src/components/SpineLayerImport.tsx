import { useRef, useState } from "react";
import { Layers, Upload, X } from "lucide-react";
import { tr } from "../lib/i18n";
import { SPINE_ROLES, type SpineProject } from "../lib/spine";
import {
  createSpineProjectFromLayers,
  type PreparedSpineLayers,
} from "../lib/spineLayers";
import { prepareSpineLayerFiles } from "../lib/spineLayerAssets";

export function SpineLayerImport({
  initial,
  onClose,
  onImport,
}: {
  initial?: PreparedSpineLayers;
  onClose: () => void;
  onImport: (project: SpineProject) => Promise<void>;
}) {
  const [prepared, setPrepared] = useState(initial),
    [name, setName] = useState(tr("拆层角色", "Layered character")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    input = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDivElement>(null);
  const roles = [
    tr("躯干", "Torso"),
    tr("头部", "Head"),
    tr("画面左臂", "Left arm"),
    tr("画面右臂", "Right arm"),
    tr("画面左腿", "Left leg"),
    tr("画面右腿", "Right leg"),
    tr("其他", "Other"),
  ];
  const count = prepared?.layers.filter((l) => l.included).length ?? 0;
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="spine-modal-backdrop">
      <div
        className="spine-layer-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={tr("图层重组与绑定", "Layer assembly & rigging")}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Tab") {
            const items = Array.from(
              dialog.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled):not([hidden]),select:not(:disabled)",
              ),
            );
            const first = items[0],
              last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="spine-section-title">
          <Layers size={18} />
          <h2>{tr("图层重组与绑定", "Layer assembly & rigging")}</h2>
          <button
            autoFocus
            disabled={busy}
            aria-label={tr("关闭图层导入", "Close layer import")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p className="spine-hint">
          {tr(
            "导入 See-through 的图层 JSON 和 PNG。保留画布位置和清单顺序，先检查重组效果再创建新工程。",
            "Import See-through layer JSON and PNGs. Canvas positions and manifest order are preserved. Review the composite before creating a new project.",
          )}
        </p>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept=".json,.png"
          aria-label={tr("图层清单及 PNG", "Layer manifest and PNGs")}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length)
              void act(async () =>
                setPrepared(await prepareSpineLayerFiles(files)),
              );
          }}
        />
        <fieldset disabled={busy}>
          <div className="spine-button-row">
            <button onClick={() => input.current?.click()}>
              <Upload size={14} />
              {tr("选择清单及 PNG", "Choose manifest & PNGs")}
            </button>
            <input
              aria-label={tr("导入后的工程名称", "Imported project name")}
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {prepared && (
            <>
              <div className="spine-layer-layout">
                <div className="spine-layer-composite">
                  <svg
                    viewBox={`0 0 ${prepared.manifest.width} ${prepared.manifest.height}`}
                    role="img"
                    aria-label={tr("图层重组预览", "Layer composite preview")}
                  >
                    {prepared.layers
                      .filter((l) => l.included)
                      .map((l) => (
                        <image
                          key={l.entry.filename}
                          href={l.originalImage}
                          x={l.entry.left}
                          y={l.entry.top}
                          width={l.entry.right - l.entry.left}
                          height={l.entry.bottom - l.entry.top}
                        />
                      ))}
                  </svg>
                  <small>
                    {prepared.manifest.width} × {prepared.manifest.height} ·{" "}
                    {count}/24 {tr("已选", "selected")}
                  </small>
                </div>
                <div className="spine-layer-rows">
                  {prepared.layers.map((layer, index) => (
                    <div className="spine-layer-row" key={layer.entry.filename}>
                      <label>
                        <input
                          type="checkbox"
                          checked={layer.included}
                          aria-label={`${tr("包含", "Include")} ${layer.entry.name}`}
                          onChange={(e) =>
                            setPrepared({
                              ...prepared,
                              layers: prepared.layers.map((l, i) =>
                                i === index
                                  ? { ...l, included: e.target.checked }
                                  : !e.target.checked && l.parentIndex === index
                                    ? { ...l, parentIndex: null }
                                    : l,
                              ),
                            })
                          }
                        />
                        <img src={layer.image} alt="" />
                        <span>
                          {layer.entry.name}
                          <small>
                            {layer.entry.left},{layer.entry.top} ·{" "}
                            {layer.entry.right - layer.entry.left}×
                            {layer.entry.bottom - layer.entry.top}
                          </small>
                        </span>
                      </label>
                      {layer.warning && (
                        <small className="spine-layer-warning">
                          {layer.warning}
                        </small>
                      )}
                      <div className="spine-button-row">
                        <select
                          aria-label={`${layer.entry.name} ${tr("角色", "role")}`}
                          value={layer.role}
                          onChange={(e) =>
                            setPrepared({
                              ...prepared,
                              layers: prepared.layers.map((l, i) =>
                                i === index
                                  ? {
                                      ...l,
                                      role: e.target.value as typeof l.role,
                                    }
                                  : l,
                              ),
                            })
                          }
                        >
                          {SPINE_ROLES.map((role, i) => (
                            <option key={role} value={role}>
                              {roles[i]}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`${layer.entry.name} ${tr("父骨骼", "parent")}`}
                          value={layer.parentIndex ?? ""}
                          onChange={(e) =>
                            setPrepared({
                              ...prepared,
                              layers: prepared.layers.map((l, i) =>
                                i === index
                                  ? {
                                      ...l,
                                      parentIndex:
                                        e.target.value === ""
                                          ? null
                                          : Number(e.target.value),
                                    }
                                  : l,
                              ),
                            })
                          }
                        >
                          <option value="">root</option>
                          {prepared.layers.map((l, i) =>
                            i !== index && l.included ? (
                              <option key={i} value={i}>
                                {l.entry.name}
                              </option>
                            ) : null,
                          )}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <p className="spine-hint">
                {tr(
                  "角色与父骨骼是基于名称和位置的建议，可在此修正；关节枢轴可在导入后继续调整。多于 24 层时请取消不需要的图层。",
                  "Roles and parents are name/position-based suggestions. Correct them here and refine pivots after import. Select at most 24 layers.",
                )}
              </p>
            </>
          )}
        </fieldset>
        {error && (
          <p className="spine-layer-error" role="alert">
            {error}
          </p>
        )}
        <div className="spine-button-row">
          <button
            disabled={!prepared || busy || count < 1 || count > 24}
            className="primary"
            onClick={() =>
              void act(async () => {
                if (prepared) {
                  await onImport(createSpineProjectFromLayers(prepared, name));
                  onClose();
                }
              })
            }
          >
            {busy
              ? tr("处理中…", "Working…")
              : tr("创建可编辑骨骼工程", "Create editable rig project")}
          </button>
        </div>
      </div>
    </div>
  );
}
