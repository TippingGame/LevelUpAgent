import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, RefreshCw, X } from "lucide-react";
import { isDesktop, listMediaAssets, mediaAssetUrl } from "../lib/bridge";
import { tr } from "../lib/i18n";
import type { MediaAsset } from "../lib/types";
import { loadSpineImage } from "../lib/spineAssets";
import { spineComfyRequest } from "../lib/spineBridge";
import {
  inspectSpineComfy,
  refreshSpineComfyJob,
  submitSpineComfyJob,
  validateSpineComfyEndpoint,
  type SpineComfyConfig,
  type SpineComfyJob,
} from "../lib/spineComfy";
import {
  listSpineComfyJobs,
  saveSpineComfyJob,
} from "../lib/spineComfyStorage";
import { prepareSpineLayers } from "../lib/spineLayerAssets";
import type { PreparedSpineLayers } from "../lib/spineLayers";
import type { SpineSourceImage } from "../lib/spineSource";

const initialConfig: SpineComfyConfig = {
  endpoint: "http://127.0.0.1:8188",
  layerModel: "",
  depthModel: "",
  resolution: 768,
  steps: 30,
  seed: 42,
  quant: "nf4",
  groupOffload: true,
};
const pending = (job: SpineComfyJob) =>
  ["preparing", "submitting", "running", "uncertain"].includes(job.state);
const stateLabel = (state: SpineComfyJob["state"]) =>
  ({
    preparing: tr("准备中", "Preparing"),
    submitting: tr("提交中", "Submitting"),
    running: tr("排队 / 推理中", "Queued / running"),
    complete: tr("拆层完成", "Layers ready"),
    failed: tr("失败", "Failed"),
    uncertain: tr("提交状态待确认", "Submission uncertain"),
    untracked: tr(
      "已停止跟踪（服务端可能仍在运行）",
      "Untracked (may still be running)",
    ),
  })[state];

export function SpineComfyPanel({
  open,
  active,
  onClose,
  onReview,
  onPendingCountChange,
  initialSource,
}: {
  open: boolean;
  active: boolean;
  onClose: () => void;
  onReview: (layers: PreparedSpineLayers) => void;
  onPendingCountChange: (count: number) => void;
  initialSource?: SpineSourceImage;
}) {
  const [config, setConfig] = useState(initialConfig),
    [inspection, setInspection] =
      useState<ReturnType<typeof inspectSpineComfy>>(),
    [checkedEndpoint, setCheckedEndpoint] = useState("");
  const [source, setSource] = useState<{ name: string; image: string }>(),
    [history, setHistory] = useState<MediaAsset[] | null>(null);
  const [jobs, setJobs] = useState<SpineComfyJob[]>([]),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    mounted = useRef(true),
    close = useRef<HTMLButtonElement>(null),
    dialog = useRef<HTMLDivElement>(null);
  const checkpoint = useCallback(async (job: SpineComfyJob) => {
    // Keep the receipt in memory even if IndexedDB runs out of space.
    if (mounted.current)
      setJobs((list) =>
        [job, ...list.filter((j) => j.id !== job.id)].sort(
          (a, b) => b.createdAt - a.createdAt,
        ),
      );
    await saveSpineComfyJob(job);
  }, []);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void listSpineComfyJobs()
      .then(async (list) => {
        const recovered = list.map(
          (j): SpineComfyJob =>
            j.state === "submitting"
              ? {
                  ...j,
                  state: "uncertain",
                  error: tr(
                    "应用关闭前未保存提交回执，请找回任务。",
                    "No saved receipt before shutdown. Recover this job.",
                  ),
                }
              : j.state === "preparing"
                ? {
                    ...j,
                    state: "failed",
                    error: tr(
                      "准备过程已中断，未提交推理。",
                      "Preparation interrupted before inference submission.",
                    ),
                  }
                : j,
        );
        if (disposed) return;
        setJobs(recovered);
        if (recovered[0]) setConfig(recovered[0].config);
        for (let i = 0; i < list.length; i++)
          if (list[i] !== recovered[i]) await saveSpineComfyJob(recovered[i]);
        if (!disposed) setLoaded(true);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onPendingCountChange(jobs.filter(pending).length);
    return () => onPendingCountChange(0);
  }, [jobs, onPendingCountChange]);
  useEffect(() => {
    if (open && active) close.current?.focus();
  }, [open, active]);
  useEffect(() => {
    if (open && initialSource) setSource({ name: initialSource.name, image: initialSource.image });
  }, [open, initialSource]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refresh = async (job: SpineComfyJob) => {
    await refreshSpineComfyJob(job, spineComfyRequest, checkpoint);
  };
  useEffect(() => {
    if (!open || !active || busy) return;
    const next = jobs
      .filter((j) => j.state === "running")
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!next) return;
    const timer = setTimeout(
      () => void run(() => refresh(next)),
      next.error ? 30000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [open, active, jobs, busy]);
  const chooseSource = async (url: string, name: string) => {
    const image = await loadSpineImage(url);
    if (image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024)
      throw new Error("Source image exceeds 32 MP");
    const scale = Math.min(
        1,
        2048 / Math.max(image.naturalWidth, image.naturalHeight),
      ),
      canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas
      .getContext("2d")!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png");
    if (png.length > 22 * 1024 * 1024)
      throw new Error("Source PNG exceeds 16 MiB");
    setSource({ name: name.slice(0, 160), image: png });
    setHistory(null);
  };
  const ready =
    inspection &&
    !inspection.missing.length &&
    checkedEndpoint === config.endpoint &&
    config.layerModel &&
    config.depthModel;
  return (
    <div className="spine-modal-backdrop" hidden={!open || !active}>
      <div
        className="spine-layer-dialog spine-comfy-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={tr("本地 AI 拆层", "Local AI layers")}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
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
          <Cpu size={18} />
          <h2>{tr("本地 AI 拆层", "Local AI layers")}</h2>
          <button
            ref={close}
            aria-label={tr("关闭本地拆层", "Close local layers")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p className="spine-hint">
          {tr(
            "将整张角色图拆成可绑定部件。需要本机 ComfyUI、See-through 模型及 LevelUpSpineExport 节点；完成后先检查图层，再创建骨骼工程。",
            "Split a character into riggable parts. Requires local ComfyUI, See-through models and LevelUpSpineExport. Review the layers before creating a rig.",
          )}
        </p>
        {!isDesktop() && (
          <p className="spine-layer-warning">
            {tr(
              "本地服务连接需使用桌面版；浏览器中可使用图层清单导入。",
              "Use the desktop app to connect to the local service. Manifest import is available in the browser.",
            )}
          </p>
        )}
        <fieldset disabled={busy || !loaded || !isDesktop()}>
          <div className="spine-comfy-config">
            <label className="spine-label">
              ComfyUI
              <input
                aria-label="ComfyUI URL"
                value={config.endpoint}
                onChange={(e) => {
                  setConfig({ ...config, endpoint: e.target.value });
                  setInspection(undefined);
                }}
              />
            </label>
            <button
              onClick={() =>
                void run(async () => {
                  const endpoint = validateSpineComfyEndpoint(config.endpoint);
                  const result = inspectSpineComfy(
                    await spineComfyRequest(endpoint, "info", {}),
                  );
                  setInspection(result);
                  setCheckedEndpoint(endpoint);
                  setConfig({
                    ...config,
                    endpoint,
                    layerModel: result.layerModels.includes(config.layerModel)
                      ? config.layerModel
                      : (result.layerModels[0] ?? ""),
                    depthModel: result.depthModels.includes(config.depthModel)
                      ? config.depthModel
                      : (result.depthModels[0] ?? ""),
                  });
                })
              }
            >
              {tr("检查连接与模型", "Check connection & models")}
            </button>
            <label className="spine-label">
              {tr("拆层模型", "Layer model")}
              <select
                value={config.layerModel}
                onChange={(e) =>
                  setConfig({ ...config, layerModel: e.target.value })
                }
              >
                <option value="">
                  {tr("先检查连接", "Check connection first")}
                </option>
                {inspection?.layerModels.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="spine-label">
              {tr("深度模型", "Depth model")}
              <select
                value={config.depthModel}
                onChange={(e) =>
                  setConfig({ ...config, depthModel: e.target.value })
                }
              >
                <option value="">
                  {tr("先检查连接", "Check connection first")}
                </option>
                {inspection?.depthModels.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="spine-label">
              {tr("分辨率", "Resolution")}
              <select
                value={config.resolution}
                onChange={(e) =>
                  setConfig({ ...config, resolution: Number(e.target.value) })
                }
              >
                {[512, 768, 1024, 1280].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="spine-label">
              {tr("步数", "Steps")}
              <input
                type="number"
                min={1}
                max={100}
                value={config.steps}
                onChange={(e) =>
                  setConfig({ ...config, steps: e.target.valueAsNumber })
                }
              />
            </label>
            <label className="spine-label">
              {tr("随机种子", "Seed")}
              <input
                type="number"
                min={0}
                max={4294967295}
                value={config.seed}
                onChange={(e) =>
                  setConfig({ ...config, seed: e.target.valueAsNumber })
                }
              />
            </label>
            <label className="spine-label">
              {tr("量化", "Quantization")}
              <select
                value={config.quant}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    quant: e.target.value as "none" | "nf4",
                  })
                }
              >
                <option value="nf4">NF4</option>
                <option value="none">{tr("不量化", "None")}</option>
              </select>
            </label>
            <label className="spine-label">
              {tr("模型分组卸载", "Group offload")}
              <select
                value={String(config.groupOffload)}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    groupOffload: e.target.value === "true",
                  })
                }
              >
                <option value="true">
                  {tr("开启（降低显存占用）", "On (reduce VRAM)")}
                </option>
                <option value="false">{tr("关闭", "Off")}</option>
              </select>
            </label>
          </div>
          <div className="spine-button-row">
            <label className="spine-label">
              {tr("整张角色图", "Character image")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label={tr("拆层原图", "Layer source image")}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file)
                    void run(async () => {
                      if (file.size > 16 * 1024 * 1024)
                        throw new Error("Source image exceeds 16 MiB");
                      const url = URL.createObjectURL(file);
                      try {
                        await chooseSource(url, file.name);
                      } finally {
                        URL.revokeObjectURL(url);
                      }
                    });
                }}
              />
            </label>
            <button
              onClick={() =>
                void run(async () =>
                  setHistory(
                    (await listMediaAssets("image", 24)).assets.filter(
                      (a) => a.status === "completed" && a.filePath,
                    ),
                  ),
                )
              }
            >
              {tr("从生图历史选择原图", "Choose source from generated images")}
            </button>
          </div>
          {source && (
            <div className="spine-comfy-source">
              <img src={source.image} alt={source.name} />
              <span>{source.name}</span>
            </div>
          )}
          {history && (
            <div className="spine-history-grid">
              {!history.length && (
                <p>{tr("暂无已完成的生图。", "No completed images.")}</p>
              )}
              {history.map((asset) => (
                <button
                  key={asset.id}
                  onClick={() =>
                    void run(() =>
                      chooseSource(
                        mediaAssetUrl(asset)!,
                        asset.fileName ?? asset.id,
                      ),
                    )
                  }
                >
                  <img src={mediaAssetUrl(asset)} alt={asset.prompt} />
                  <span>{asset.prompt}</span>
                </button>
              ))}
            </div>
          )}
          <button
            className="primary"
            disabled={!ready || !source || jobs.some(pending)}
            onClick={() =>
              void run(async () => {
                if (!source) return;
                const now = Date.now();
                const job: SpineComfyJob = {
                  id: crypto.randomUUID().replace(/-/g, ""),
                  sourceName: source.name,
                  config: { ...config },
                  createdAt: now,
                  updatedAt: now,
                  state: "preparing",
                };
                await submitSpineComfyJob(
                  job,
                  source.image,
                  spineComfyRequest,
                  checkpoint,
                );
              })
            }
          >
            {busy
              ? tr("处理中…", "Working…")
              : tr("开始本地拆层", "Start local layer generation")}
          </button>
        </fieldset>
        {inspection && (
          <p
            className={
              inspection.missing.length ? "spine-layer-warning" : "spine-hint"
            }
          >
            {inspection.missing.length
              ? `${tr("缺少节点或接口：", "Missing nodes or interfaces: ")}${inspection.missing.join(", ")}`
              : tr(
                  "节点接口可用。模型列表不代表权重已下载；请在 ComfyUI 中准备权重。",
                  "Node interfaces available. Model choices do not guarantee installed weights; prepare weights in ComfyUI.",
                )}
          </p>
        )}
        <p className="spine-hint">
          {tr(
            "不会自动下载模型。首次建议 768 / NF4 / 开启分组卸载，实际显存需求取决于模型。关闭面板后本地推理继续；重新打开可刷新。",
            "Models are not downloaded automatically. Start with 768 / NF4 / group offload; VRAM needs depend on the model. Inference continues when this panel closes. Reopen to refresh.",
          )}
        </p>
        {error && (
          <p role="alert" className="spine-layer-error">
            {error}
          </p>
        )}
        <div className="spine-comfy-jobs">
          {jobs.map((job) => (
            <article key={job.id}>
              <strong>
                {job.sourceName} · {stateLabel(job.state)}
              </strong>
              <small>
                {new Date(job.createdAt).toLocaleString()} ·{" "}
                {job.config.endpoint}
              </small>
              <small>
                {tr("任务", "Job")}: {job.id}
                {job.promptId
                  ? ` · ${tr("回执", "Receipt")}: ${job.promptId}`
                  : ""}
              </small>
              {job.error && <p className="spine-layer-error">{job.error}</p>}
              <div className="spine-button-row">
                {["running", "uncertain", "untracked"].includes(job.state) && (
                  <button
                    disabled={busy || !isDesktop()}
                    onClick={() => void run(() => refresh(job))}
                  >
                    <RefreshCw size={13} />
                    {job.promptId
                      ? tr("刷新任务", "Refresh job")
                      : tr("找回提交回执", "Recover receipt")}
                  </button>
                )}
                {["running", "uncertain"].includes(job.state) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        checkpoint({
                          ...job,
                          state: "untracked",
                          updatedAt: Date.now(),
                        }),
                      )
                    }
                  >
                    {tr(
                      "停止跟踪（不取消推理）",
                      "Stop tracking (inference continues)",
                    )}
                  </button>
                )}
                {job.state === "complete" && job.manifest && (
                  <button
                    disabled={busy || !isDesktop()}
                    onClick={() =>
                      void run(async () => {
                        const prepared = await prepareSpineLayers(
                          job.manifest,
                          job.sourceName,
                          async (filename) => {
                            const result = (await spineComfyRequest(
                              job.config.endpoint,
                              "image",
                              { jobId: job.id, filename },
                            )) as { image: string };
                            return result.image;
                          },
                        );
                        onReview(prepared);
                        onClose();
                      })
                    }
                  >
                    {tr("检查图层并创建骨骼", "Review layers & create rig")}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
