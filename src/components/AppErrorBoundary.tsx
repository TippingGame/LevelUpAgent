import { Component, type ErrorInfo, type ReactNode } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { openAppLogDirectory, reportFrontendError } from "../lib/appLogging";
import "./AppErrorBoundary.css";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

function isChineseLocale() {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
}

export function FatalErrorView({ error }: { error: Error }) {
  const zh = isChineseLocale();
  return (
    <main className="fatal-error-screen" role="alert">
      <div className="fatal-error-panel">
        <span className="fatal-error-mark">!</span>
        <h1>{zh ? "界面渲染失败" : "The interface could not render"}</h1>
        <p>{zh
          ? "错误已经写入本地日志。你可以重新加载应用；如果问题持续，请打开日志目录进行分析。"
          : "The error was written to the local log. Reload the app, or open the log directory if the problem continues."}</p>
        <pre>{error.message || String(error)}</pre>
        <div className="fatal-error-actions">
          <button type="button" onClick={() => window.location.reload()}>
            <RefreshCw size={16} />{zh ? "重新加载" : "Reload"}
          </button>
          <button type="button" onClick={() => void openAppLogDirectory()}>
            <FolderOpen size={16} />{zh ? "打开日志目录" : "Open logs"}
          </button>
        </div>
      </div>
    </main>
  );
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportFrontendError("react_error_boundary", error, info.componentStack ?? undefined);
  }

  render() {
    if (this.state.error) return <FatalErrorView error={this.state.error} />;
    return this.props.children;
  }
}
