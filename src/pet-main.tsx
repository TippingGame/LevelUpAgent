import React, { Profiler } from "react";
import ReactDOM from "react-dom/client";
import { AppErrorBoundary, FatalErrorView } from "./components/AppErrorBoundary";
import { installFrontendDiagnostics, reportFrontendError, reportReactCommit } from "./lib/appLogging";

installFrontendDiagnostics();

const rootElement = document.getElementById("pet-root") ?? document.body.appendChild(document.createElement("div"));
const root = ReactDOM.createRoot(rootElement);

void import("./PetOverlay")
  .then(({ PetOverlay }) => {
    root.render(
      <React.StrictMode>
        <AppErrorBoundary>
          <Profiler id="PetOverlay" onRender={(_id, phase, actualDuration, _baseDuration, _startTime, commitTime) => reportReactCommit(phase, actualDuration, commitTime)}>
            <PetOverlay />
          </Profiler>
        </AppErrorBoundary>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    reportFrontendError("pet_module_load_failed", normalized);
    root.render(<FatalErrorView error={normalized} />);
  });
