import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";

interface StartupBoundaryProps {
  children: ReactNode;
}

interface StartupBoundaryState {
  error?: Error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const summary = `${error.name}: ${error.message}`;
    return error.stack && !error.stack.startsWith(summary)
      ? `${summary}\n${error.stack}`
      : error.stack || summary;
  }
  return String(error);
}

function StartupFailure({ error }: { error: unknown }) {
  return (
    <main style={{
      width: "100%",
      minHeight: "100%",
      display: "grid",
      placeItems: "center",
      padding: 32,
      background: "#f8fafc",
      color: "#111827",
      fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      <section style={{ width: "min(680px, 100%)" }}>
        <h1 style={{ margin: "0 0 12px", fontSize: 22 }}>LevelUpAgent could not start</h1>
        <p style={{ margin: "0 0 18px", color: "#64748b" }}>
          The application encountered an error while loading its interface.
        </p>
        <pre style={{
          margin: 0,
          padding: 16,
          overflow: "auto",
          border: "1px solid #cbd5e1",
          borderRadius: 6,
          background: "#fff",
          color: "#991b1b",
          font: "12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}>{errorText(error)}</pre>
      </section>
    </main>
  );
}

class StartupBoundary extends Component<StartupBoundaryProps, StartupBoundaryState> {
  state: StartupBoundaryState = {};

  static getDerivedStateFromError(error: Error): StartupBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("LevelUpAgent interface failed to render", error, info.componentStack);
  }

  render() {
    if (this.state.error) return <StartupFailure error={this.state.error} />;
    return this.props.children;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("LevelUpAgent root element is missing");
const root = ReactDOM.createRoot(rootElement);

void import("./App")
  .then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <StartupBoundary>
          <App />
        </StartupBoundary>
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    console.error("LevelUpAgent interface failed to load", error);
    root.render(<StartupFailure error={error} />);
  });
