import { Suspense, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { tr } from "../lib/i18n";

export function WorkspaceLoading() {
  return <div className="workspace-loading" role="status">
    <LoaderCircle size={20} className="spin" />
    <span>{tr("正在加载", "Loading")}</span>
  </div>;
}

/** Load on first visit, then keep background runs and unsaved edits alive. */
export function DeferredWorkspace({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return null;
  return <Suspense fallback={active ? <WorkspaceLoading /> : null}>{children}</Suspense>;
}
