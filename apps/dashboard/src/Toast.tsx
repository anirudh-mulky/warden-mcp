import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/**
 * Toast notifications: a short message that slides in at the bottom-right,
 * stays ~3s, and fades out. Every save in the dashboard reports through one,
 * so feedback is visible wherever on the page the button was.
 */

type Kind = "success" | "error";
interface Toast {
  id: number;
  kind: Kind;
  text: string;
  leaving: boolean;
}

const ToastContext = createContext<(kind: Kind, text: string) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

const SHOW_MS = 3200;
const LEAVE_MS = 250; // matches the CSS exit animation

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), LEAVE_MS);
  }, []);

  const show = useCallback(
    (kind: Kind, text: string) => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list.slice(-3), { id, kind, text, leaving: false }]);
      setTimeout(() => dismiss(id), SHOW_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}${t.leaving ? " leaving" : ""}`}>
            <span className="toast-icon" aria-hidden="true">
              {t.kind === "success" ? "✓" : "!"}
            </span>
            <span>{t.text}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
