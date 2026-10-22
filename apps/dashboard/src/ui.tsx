import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Verdict } from "@warden/shared";
import { ApiError } from "./api";

/* ---------------------------------------------------------------- hooks */

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Re-run `load` every `ms` while mounted. */
export function usePoll(load: () => void | Promise<unknown>, ms: number, deps: unknown[] = []) {
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* -------------------------------------------------------------- format */

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function until(iso: string, now: number): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return "expired";
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86_400);
  if (d >= 1) return `${d} day${d === 1 ? "" : "s"}`;
  const h = Math.floor(s / 3600);
  return h >= 1 ? `${h}h` : `${Math.ceil(s / 60)}m`;
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export const VERDICT_NAME: Record<Verdict, string> = { allow: "Allowed", throttle: "Throttled", deny: "Blocked", error: "Error" };

/* -------------------------------------------------------------- pieces */

export function Card({ title, subtitle, actions, children, className, icon }: { title?: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <section className={`glass card ${className ?? ""}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="card-head">
          <div className="card-title">
            {icon !== undefined && <span className="card-icon">{icon}</span>}
            <div>
              {title !== undefined && <h2>{title}</h2>}
              {subtitle !== undefined && <p className="muted">{subtitle}</p>}
            </div>
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tile({ label, value, hint, tone, icon }: { label: string; value: ReactNode; hint?: string; tone?: "allow" | "deny" | "throttle" | "accent" | "warn"; icon?: ReactNode }) {
  return (
    <div className={`glass tile tone-${tone ?? "neutral"}`}>
      <div className="tile-top">
        <span className="tile-label">{label}</span>
        {icon !== undefined && <span className="tile-icon">{icon}</span>}
      </div>
      <span className="tile-value">{value}</span>
      {hint !== undefined && <span className="tile-hint">{hint}</span>}
    </div>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`badge ${verdict}`}>{VERDICT_NAME[verdict]}</span>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "allow" | "deny" | "throttle" | "accent" }) {
  return <span className={`pill tone-${tone}`}>{children}</span>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost small"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

/** A button that shows "Saving…" while its action runs and "Saved ✓" briefly after. */
export function SaveButton({ onSave, children, className = "primary" }: { onSave: () => Promise<boolean>; children: ReactNode; className?: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  return (
    <button
      className={`btn ${className} ${state}`}
      disabled={state === "saving"}
      onClick={async () => {
        setState("saving");
        const ok = await onSave();
        setState(ok ? "saved" : "idle");
        if (ok) setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "saving" ? (
        <>
          <span className="spinner" aria-hidden="true" /> Saving…
        </>
      ) : state === "saved" ? (
        "Saved ✓"
      ) : (
        children
      )}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return (
    <label className={disabled === true ? "switch disabled" : "switch"} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="track" />
    </label>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  // Rendered into <body> through a portal. Any ancestor with backdrop-filter
  // (every glass card) becomes the containing block for position:fixed, so
  // a drawer rendered inside a card would be pinned to the card, not the screen.
  return createPortal(
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="glass drawer" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </aside>
    </div>,
    document.body,
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-orb" aria-hidden="true" />
      <h3>{title}</h3>
      {children !== undefined && <div className="muted">{children}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- icons */

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
export const Icon = {
  chart: <Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>,
  shield: <Svg><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></Svg>,
  key: <Svg><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M14 9l2 2" /></Svg>,
  plug: <Svg><path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 01-12 0V7zM12 17v4" /></Svg>,
  hand: <Svg><path d="M7 11V6a2 2 0 014 0v5M11 10V4a2 2 0 014 0v6M15 10V6a2 2 0 014 0v8a7 7 0 01-7 7h-1a6 6 0 01-5.2-3L3 14a2 2 0 013.4-2L7 13" /></Svg>,
  server: <Svg><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></Svg>,
  list: <Svg><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Svg>,
  bell: <Svg><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" /></Svg>,
  bolt: <Svg><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></Svg>,
  check: <Svg><path d="M20 6L9 17l-5-5" /></Svg>,
  ban: <Svg><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></Svg>,
  clock: <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>,
  gauge: <Svg><path d="M12 14l4-4M3.5 18a9 9 0 1117 0" /></Svg>,
  download: <Svg><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Svg>,
  mask: <Svg><path d="M3 9c3-2 15-2 18 0 0 6-4 9-9 9s-9-3-9-9z" /><circle cx="8.5" cy="11.5" r="1.5" /><circle cx="15.5" cy="11.5" r="1.5" /></Svg>,
  out: <Svg><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" /></Svg>,
};
