import { useState } from "react";
import { Trash2 } from "lucide-react";
import { tr } from "../lib/i18n";
import "./ResourceRemovalControl.css";

export function ResourceRemovalControl({ scope, disabled, onRemove }: {
  scope: string; disabled: boolean; onRemove: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return <div className="resource-removal">
    {confirming ? <div className="resource-removal-confirm" role="group" aria-label={tr("确认移除依赖", "Confirm dependency removal")}>
      <strong>{tr(`移除${scope}？`, `Remove ${scope}?`)}</strong>
      <p>{tr("将清理运行环境、模型及安装缓存。作品、创作历史、参考文件和原始离线资源包会保留。再次生成前需要重新下载或离线导入。", "This removes the runtime, models and installation cache. Creations, history, references and original offline packs are kept. Download or import the resources again before generating.")}</p>
      <div><button type="button" disabled={disabled} className="resource-removal-danger" onClick={() => { setConfirming(false); void onRemove(); }}>{tr("确认移除", "Confirm removal")}</button><button type="button" disabled={disabled} onClick={() => setConfirming(false)}>{tr("取消", "Cancel")}</button></div>
    </div> : <button type="button" className="resource-removal-danger" disabled={disabled} onClick={() => setConfirming(true)}><Trash2 size={14}/>{tr("移除已安装依赖", "Remove installed dependencies")}</button>}
  </div>;
}
