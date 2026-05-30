// app/web/src/components/ErrorBoundary.tsx
//
// Class-based React error boundary. React still requires class components for
// componentDidCatch; functional boundary wrappers depend on third-party libs.
//
// Usage:
//   <ErrorBoundary fallbackVariant="kid">
//     <Diary />
//   </ErrorBoundary>
//
//   <ErrorBoundary fallbackVariant="admin" label="Audit tab">
//     <AuditSettings />
//   </ErrorBoundary>
//
// Fallback variants:
//   - "kid"   — friendly, emoji-heavy copy for child-facing views
//   - "admin" — more technical copy for settings / admin views

import { Component, ErrorInfo, ReactNode } from 'react';

export type FallbackVariant = 'kid' | 'admin';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Controls which fallback copy / style to show (default: "admin"). */
  fallbackVariant?: FallbackVariant;
  /**
   * Optional label surfaced in the admin fallback and in the console log,
   * e.g. "Audit tab" or "Camera grid". When omitted, a generic label is used.
   */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const label = this.props.label ?? 'unknown section';
    // Log with enough context to debug from a screenshot.
    console.error(
      `[ErrorBoundary] Caught in "${label}":`,
      error,
      '\nComponent stack:',
      info.componentStack,
    );
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }

    const variant = this.props.fallbackVariant ?? 'admin';

    if (variant === 'kid') {
      return <KidFallback onReset={this.handleReset} onReload={this.handleReload} />;
    }

    return (
      <AdminFallback
        label={this.props.label}
        error={this.state.error}
        onReset={this.handleReset}
        onReload={this.handleReload}
      />
    );
  }
}

// ---------------------------------------------------------------------------
// Kid-friendly fallback — used for Diary, CameraGrid, MaximizedCamera
// ---------------------------------------------------------------------------

interface KidFallbackProps {
  onReset: () => void;
  onReload: () => void;
}

function KidFallback({ onReset, onReload }: KidFallbackProps): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 32,
        borderRadius: 20,
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        textAlign: 'center',
        minHeight: 200,
      }}
    >
      <div aria-hidden style={{ fontSize: 56, lineHeight: 1 }}>🐾</div>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 18 }}>
        Oops! Something went a little wonky.
      </p>
      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 15 }}>
        Tap below to try again, or ask a grown-up to refresh the page.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          className="hc-btn hc-btn-primary"
          style={{ minHeight: 64, padding: '0 28px', fontSize: 16 }}
          onClick={onReset}
        >
          Try again
        </button>
        <button
          type="button"
          className="hc-btn"
          style={{ minHeight: 64, padding: '0 28px', fontSize: 16 }}
          onClick={onReload}
        >
          Refresh the page
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin fallback — used for settings tabs, login, onboarding
// ---------------------------------------------------------------------------

interface AdminFallbackProps {
  label?: string;
  error: Error;
  onReset: () => void;
  onReload: () => void;
}

function AdminFallback({ label, error, onReset, onReload }: AdminFallbackProps): JSX.Element {
  const section = label ? `"${label}"` : 'this section';
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 20,
        borderRadius: 12,
        background: 'var(--surface-raised)',
        border: '1px solid var(--danger)',
        color: 'var(--text)',
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>
        Something went wrong in {section}.
      </p>
      <code
        style={{
          fontSize: 12,
          background: 'var(--surface)',
          padding: '8px 10px',
          borderRadius: 8,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {error.message}
      </code>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
        Tap &ldquo;Try again&rdquo; to re-mount, or &ldquo;Refresh&rdquo; to reload the page. Check the
        browser console for the full stack trace.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="hc-btn hc-btn-primary" onClick={onReset}>
          Try again
        </button>
        <button type="button" className="hc-btn" onClick={onReload}>
          Refresh page
        </button>
      </div>
    </div>
  );
}
