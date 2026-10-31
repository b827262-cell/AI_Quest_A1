import { Component, Suspense, type ReactNode } from "react";

class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) {
      return <div role="alert" style={{ minHeight: "12rem", padding: "1rem" }}>
        <p>頁面載入失敗，請重新載入後再試。</p>
        <button type="button" onClick={() => window.location.reload()}>重新載入</button>
      </div>;
    }
    return this.props.children;
  }
}

export function RouteLoading({ children }: { children: ReactNode }) {
  return <RouteErrorBoundary><Suspense fallback={<div role="status" aria-live="polite" style={{ minHeight: "12rem", padding: "1rem" }}>載入中…</div>}>
    {children}
  </Suspense></RouteErrorBoundary>;
}
