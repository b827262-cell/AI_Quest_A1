import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  loading?: boolean;
  success?: boolean;
  error?: boolean;
  icon?: ReactNode;
}

export function PrimaryButton({ children, loading, success, error, icon, className = "", ...props }: ButtonProps) {
  let statusText = "";
  if (loading) statusText = " 載入中...";
  if (success) statusText = " ✓ 成功";
  if (error) statusText = " ✕ 失敗";

  return (
    <button
      className={`gemini-btn gemini-btn-primary ${loading ? "is-loading" : ""} ${success ? "is-success" : ""} ${error ? "is-error" : ""} ${className}`}
      {...props}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-label">{children}</span>
      {statusText && <span className="btn-status-text">{statusText}</span>}
    </button>
  );
}

export function SecondaryButton({ children, loading, success, error, icon, className = "", ...props }: ButtonProps) {
  let statusText = "";
  if (loading) statusText = " 載入中...";
  if (success) statusText = " ✓";
  if (error) statusText = " ✕";

  return (
    <button
      className={`gemini-btn gemini-btn-secondary ${loading ? "is-loading" : ""} ${success ? "is-success" : ""} ${error ? "is-error" : ""} ${className}`}
      {...props}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-label">{children}</span>
      {statusText && <span className="btn-status-text">{statusText}</span>}
    </button>
  );
}

export function GhostButton({ children, loading, success, error, icon, className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`gemini-btn gemini-btn-ghost ${loading ? "is-loading" : ""} ${success ? "is-success" : ""} ${error ? "is-error" : ""} ${className}`}
      {...props}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-label">{children}</span>
    </button>
  );
}

export function DangerButton({ children, loading, success, error, icon, className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`gemini-btn gemini-btn-danger ${loading ? "is-loading" : ""} ${success ? "is-success" : ""} ${error ? "is-error" : ""} ${className}`}
      {...props}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-label">{children}</span>
    </button>
  );
}

export function IconButton({ children, className = "", ...props }: ButtonProps) {
  return (
    <button className={`gemini-btn-icon ${className}`} {...props}>
      {children}
    </button>
  );
}

export function AIActionButton({ children, loading, success, error, icon, className = "", ...props }: ButtonProps) {
  let statusText = "";
  if (loading) statusText = "...";
  if (success) statusText = " ✓";
  if (error) statusText = " ✕";

  return (
    <button
      className={`gemini-btn gemini-btn-ai ${loading ? "is-loading" : ""} ${success ? "is-success" : ""} ${error ? "is-error" : ""} ${className}`}
      {...props}
    >
      <span className="btn-sparkle-icon" aria-hidden="true">✨</span>
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-label">{children}</span>
      {statusText && <span className="btn-status-text">{statusText}</span>}
    </button>
  );
}

export function FloatingActionButton({ children, className = "", ...props }: ButtonProps) {
  return (
    <button className={`gemini-btn-fab ${className}`} {...props}>
      {children}
    </button>
  );
}

interface SegmentedControlOption<T> {
  value: T;
  label: ReactNode;
}

interface SegmentedControlProps<T> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  className = "",
  disabled = false
}: SegmentedControlProps<T>) {
  return (
    <div className={`gemini-segmented-control ${disabled ? "is-disabled" : ""} ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented-item ${value === option.value ? "is-active" : ""}`}
          onClick={() => !disabled && onChange(option.value)}
          disabled={disabled}
          role="radio"
          aria-checked={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
