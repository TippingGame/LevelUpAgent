import React, { Profiler } from "react";
import ReactDOM from "react-dom/client";
import { AppErrorBoundary, FatalErrorView } from "./components/AppErrorBoundary";
import { installFrontendDiagnostics, reportFrontendError, reportReactCommit } from "./lib/appLogging";

installFrontendDiagnostics();

const rootElement = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
const root = ReactDOM.createRoot(rootElement);

void import("./App")
  .then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <AppErrorBoundary>
          <Profiler id="LevelUpAgent" onRender={(_id, phase, actualDuration, _baseDuration, _startTime, commitTime) => reportReactCommit(phase, actualDuration, commitTime)}>
            <App />
          </Profiler>
        </AppErrorBoundary>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    reportFrontendError("app_module_load_failed", normalized);
    root.render(<FatalErrorView error={normalized} />);
  });
