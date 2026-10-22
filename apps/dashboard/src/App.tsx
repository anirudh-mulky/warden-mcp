import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiKey, Me, Policy, ToolCallRecord, ToolInfo, ToolStats, Verdict } from "@warden/shared";
import { api, ApiError } from "./api";
import { CallsChart, VERDICT_NAME } from "./CallsChart";
import { ToastProvider, useToast } from "./Toast";

const FEED_LIMIT = 500;
const POLL_MS = 2_000;

/** Where agents connect. In local dev the dashboard (5173) and gateway (8080) are separate servers. */
const MCP_URL = location.port === "5173" ? "http://localhost:8080/mcp" : `${location.origin}/mcp`;

type Tab = "overview" | "policy" | "keys" | "connect";
const PAGES: { id: Tab; label: string; title: string; subtitle: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", title: "Overview", subtitle: "Every tool call your agents make, as it happens.", icon: <IconChart /> },
  { id: "policy", label: "Policy", title: "Policy", subtitle: "Choose which tools your agents may call, and how often.", icon: <IconShield /> },
  { id: "keys", label: "API keys", title: "API keys", subtitle: "Credentials your agents use to connect to Warden.", icon: <IconKey /> },
  { id: "connect", label: "Connect", title: "Connect an agent", subtitle: "Point any MCP client at Warden in under a minute.", icon: <IconPlug /> },
];

/* ------------------------------------------------------------------ icons */

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
function IconChart() {
  return <Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>;
}
function IconShield() {
  return <Svg><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></Svg>;
}
function IconKey() {
  return <Svg><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M14 9l2 2" /></Svg>;
}
function IconPlug() {
  return <Svg><path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 01-12 0V7zM12 17v4" /></Svg>;
}

/* ---------------------------------------------------------------- helpers */

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`badge ${verdict}`}>{VERDICT_NAME[verdict]}</span>;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
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
function SaveButton({ onSave, children }: { onSave: () => Promise<boolean>; children: ReactNode }) {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  return (
    <button
      className={`btn primary ${state}`}
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

function Card({ title, subtitle, actions, children, className }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle !== undefined && <p className="muted">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------- app */

function currentTab(): Tab {
  const hash = location.hash.slice(1);
  return PAGES.some((p) => p.id === hash) ? (hash as Tab) : "overview";
}

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>(currentTab);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const onHash = () => setTab(currentTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (checking) return <div className="center muted">Loading…</div>;
  if (me === null) return <AuthScreen onSignedIn={setMe} />;

  const page = PAGES.find((p) => p.id === tab) ?? PAGES[0]!;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true">W</span>
          <span>Warden</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={tab === p.id ? "nav-item active" : "nav-item"} aria-current={tab === p.id ? "page" : undefined}>
              {p.icon}
              <span>{p.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <span className="avatar" aria-hidden="true">{me.email.slice(0, 1).toUpperCase()}</span>
            <div className="who-text">
              <span className="who-email" title={me.email}>{me.email}</span>
              <span className="mono muted who-tenant" title="Your tenant id">{me.tenantId}</span>
            </div>
          </div>
          <button className="btn ghost small full" onClick={() => void api.logout().finally(() => setMe(null))}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="page-head">
          <div>
            <h1>{page.title}</h1>
            <p className="muted">{page.subtitle}</p>
          </div>
          <HealthPill />
        </header>
        <div className="content">
          {tab === "overview" && <Overview onGoTo={(t) => (location.hash = t)} />}
          {tab === "policy" && <PolicyPanel />}
          {tab === "keys" && <KeysPanel />}
          {tab === "connect" && <ConnectPanel />}
        </div>
      </div>
    </div>
  );
}

/** Gateway status from /readyz: ready, degraded (some upstreams down), or unavailable. */
function HealthPill() {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  useEffect(() => {
    const load = () => api.health().then(setHealth).catch(() => setHealth(null));
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (health === null) return <span className="health unknown">Gateway unreachable</span>;
  const up = health.upstreams.filter((u) => u.status === "connected").length;
  const label = health.status === "ready" ? "Gateway healthy" : health.status === "degraded" ? "Gateway degraded" : "Gateway unavailable";
  return (
    <span className={`health ${health.status}`} title={health.upstreams.map((u) => `${u.namespace}: ${u.status}`).join("\n")}>
      <span className="health-dot" aria-hidden="true" />
      {label} · {up}/{health.upstreams.length} upstreams
    </span>
  );
}

/* ------------------------------------------------------------------- auth */

function AuthScreen({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (email.trim() === "" || password === "") {
      setError("Enter an email and a password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSignedIn(mode === "login" ? await api.login(email, password) : await api.signup(email, password, code));
    } catch (err) {
      setError(errorText(err, "Cannot reach the gateway."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-pitch">
        <div className="brand large">
          <span className="logo" aria-hidden="true">W</span>
          Warden
        </div>
        <h1>One endpoint between your AI agents and their tools.</h1>
        <ul className="pitch-list">
          <li>Decide which tools each agent may call</li>
          <li>Rate-limit every API key</li>
          <li>See every call, allowed or blocked, as it happens</li>
        </ul>
      </div>
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{mode === "login" ? "Sign in" : "Create your account"}</h2>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "At least 10 characters" : ""}
          />
        </label>
        {mode === "signup" && (
          <label className="field">
            <span>
              Sign-up code <em className="muted">(only if this server requires one)</em>
            </span>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {error !== null && <p className="error">{error}</p>}
        <button className="btn primary full" type="submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <p className="switch-mode muted">
          {mode === "login" ? "New here?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
}

/* --------------------------------------------------------------- overview */

/**
 * One poller feeds the chart and the feed: every 2s, ask for calls newer
 * than the newest one we have. Polling works identically however many
 * gateway instances run, where a long-held stream would only see the one
 * instance it happened to connect to.
 */
function useCalls() {
  const [calls, setCalls] = useState<ToolCallRecord[]>([]);
  const [live, setLive] = useState(false);
  const newest = useRef<string | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const fresh = await api.calls(newest.current);
        if (fresh.length > 0) {
          newest.current = fresh[0]?.startedAt;
          setCalls((prev) => {
            const seen = new Set(prev.map((c) => c.id));
            return [...fresh.filter((c) => !seen.has(c.id)), ...prev].slice(0, FEED_LIMIT);
          });
        }
        setLive(true);
      } catch {
        setLive(false);
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return { calls, live };
}

function Overview({ onGoTo }: { onGoTo: (tab: Tab) => void }) {
  const [stats, setStats] = useState<ToolStats[] | null>(null);
  const { calls, live } = useCalls();
  const now = useNow(5_000);

  useEffect(() => {
    const load = () => api.stats().then(setStats).catch(() => undefined);
    void load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, []);

  const totals = useMemo(() => {
    const s = stats ?? [];
    const sum = (f: (x: ToolStats) => number) => s.reduce((a, x) => a + f(x), 0);
    const p95s = s.map((x) => x.p95Ms).filter((v): v is number => v !== null);
    const calls = sum((x) => x.calls);
    return {
      calls,
      allowed: sum((x) => x.allowed),
      blocked: sum((x) => x.denied),
      throttled: sum((x) => x.throttled),
      blockedShare: calls === 0 ? null : Math.round((sum((x) => x.denied + x.throttled) / calls) * 100),
      worstP95: p95s.length === 0 ? null : Math.max(...p95s),
    };
  }, [stats]);

  const top = (stats ?? []).slice(0, 6);
  const topMax = Math.max(1, ...top.map((t) => t.calls));

  return (
    <>
      <div className="tiles">
        <Tile label="Total calls" value={totals.calls} hint="last 500" />
        <Tile label="Allowed" value={totals.allowed} tone="allow" />
        <Tile label="Blocked" value={totals.blocked} tone="deny" />
        <Tile label="Throttled" value={totals.throttled} tone="throttle" />
        <Tile label="Refused" value={totals.blockedShare === null ? "—" : `${totals.blockedShare}%`} hint="blocked + throttled" />
        <Tile label="Slowest p95" value={totals.worstP95 === null ? "—" : `${totals.worstP95} ms`} hint="worst tool" />
      </div>

      {stats !== null && stats.length === 0 && (
        <div className="empty-hero card">
          <h2>No calls yet</h2>
          <p className="muted">Create an API key, connect an MCP client to Warden, and calls will appear here live.</p>
          <div className="row center-row">
            <button className="btn primary" onClick={() => onGoTo("keys")}>
              Create a key
            </button>
            <button className="btn ghost" onClick={() => onGoTo("connect")}>
              How to connect
            </button>
          </div>
        </div>
      )}

      <div className="split">
        <Card title="Calls per minute" subtitle="Last 30 minutes, by result. Hover a bar for exact counts." className="grow-card">
          <CallsChart calls={calls} now={now} />
        </Card>
        <Card title="Top tools" subtitle="By calls, last 500 · p95 latency">
          {top.length === 0 ? (
            <p className="empty muted">Nothing yet.</p>
          ) : (
            <ul className="top-tools">
              {top.map((t) => (
                <li key={t.tool}>
                  <div className="top-row">
                    <span className="mono top-name" title={t.tool}>{t.tool}</span>
                    <span className="muted num">{t.calls}</span>
                  </div>
                  <div className="meter" aria-hidden="true">
                    <span style={{ width: `${(t.calls / topMax) * 100}%` }} />
                  </div>
                  <div className="top-meta muted">
                    {t.denied + t.throttled > 0 ? `${t.denied + t.throttled} refused · ` : ""}p95 {t.p95Ms === null ? "—" : `${t.p95Ms} ms`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <LiveFeed calls={calls} live={live} now={now} />
    </>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: Verdict }) {
  return (
    <div className={`tile ${tone ?? ""}`}>
      <span className="tile-label">
        {tone !== undefined && <span className={`swatch v-${tone}`} aria-hidden="true" />}
        {label}
      </span>
      <span className="tile-value">{value}</span>
      {hint !== undefined && <span className="tile-hint">{hint}</span>}
    </div>
  );
}

function LiveFeed({ calls, live, now }: { calls: ToolCallRecord[]; live: boolean; now: number }) {
  const [filter, setFilter] = useState<Verdict | "all">("all");
  const [query, setQuery] = useState("");
  const firstSeen = useRef<Set<string> | null>(null);

  // Rows that arrive after the first load get a short highlight.
  if (firstSeen.current === null && calls.length > 0) firstSeen.current = new Set(calls.map((c) => c.id));

  const q = query.trim().toLowerCase();
  const shown = calls.filter((c) => (filter === "all" || c.verdict === filter) && (q === "" || c.tool.toLowerCase().includes(q))).slice(0, 100);
  const filters: (Verdict | "all")[] = ["all", "allow", "deny", "throttle", "error"];

  return (
    <Card
      title="Live calls"
      subtitle={
        <span className="live">
          <span className={live ? "dot on" : "dot"} /> {live ? "Updating every 2 seconds" : "Disconnected — retrying"}
        </span>
      }
      actions={
        <div className="row">
          <input className="input search" placeholder="Filter by tool…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter by tool" />
          <div className="chips" role="group" aria-label="Filter by result">
            {filters.map((f) => (
              <button key={f} className={filter === f ? "chip active" : "chip"} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : VERDICT_NAME[f]}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {shown.length === 0 ? (
        <p className="empty muted">{calls.length === 0 ? "Waiting for the first tool call…" : "No calls match these filters."}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Result</th>
                <th className="num">Latency</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className={firstSeen.current !== null && !firstSeen.current.has(c.id) ? "fresh" : undefined}>
                  <td className="muted nowrap" title={new Date(c.startedAt).toLocaleString()}>
                    {ago(c.startedAt, now)}
                  </td>
                  <td className="mono">{c.tool}</td>
                  <td>
                    <VerdictBadge verdict={c.verdict} />
                  </td>
                  <td className="num">{c.latencyMs} ms</td>
                  <td className="muted reason">{c.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- policy */

function linesToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function PolicyPanel() {
  const toast = useToast();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [limit, setLimit] = useState("");
  const [allowText, setAllowText] = useState("");
  const [denyText, setDenyText] = useState("");
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(async (previous?: ToolInfo[]) => {
    const [p, t] = await Promise.all([api.policy(), api.tools()]);
    setPolicy(p);
    setTools(t);
    setLimit(p.rateLimitPerMinute === null ? "" : String(p.rateLimitPerMinute));
    setAllowText(p.allow.join("\n"));
    setDenyText(p.deny.join("\n"));
    // Briefly highlight every tool whose verdict this save changed.
    if (previous !== undefined) {
      const before = new Map(previous.map((x) => [x.name, x.verdict]));
      const changed = new Set(t.filter((x) => before.get(x.name) !== x.verdict).map((x) => x.name));
      setFlash(changed);
      setTimeout(() => setFlash(new Set()), 1600);
      return changed.size;
    }
    return 0;
  }, []);

  useEffect(() => {
    reload().catch(() => setLoadError(true));
  }, [reload]);

  /** Save, reload what the server now says, and report it in a toast. */
  const save = async (next: Pick<Policy, "allow" | "deny" | "rateLimitPerMinute">, message: (changed: number) => string): Promise<boolean> => {
    try {
      await api.savePolicy(next);
      const changed = await reload(tools);
      toast("success", message(changed));
      return true;
    } catch (err) {
      toast("error", errorText(err, "Save failed."));
      return false;
    }
  };

  if (loadError) return <p className="error">Could not load the policy.</p>;
  if (policy === null) return <p className="muted">Loading…</p>;

  const toggle = async (tool: ToolInfo) => {
    setBusyTool(tool.name);
    const blocked = policy.deny.includes(tool.name);
    const deny = blocked ? policy.deny.filter((d) => d !== tool.name) : [...policy.deny, tool.name];
    await save({ ...policy, deny }, () => (blocked ? `${tool.name} is allowed again` : `${tool.name} is now blocked`));
    setBusyTool(null);
  };

  const saveLimit = async (): Promise<boolean> => {
    const trimmed = limit.trim();
    if (trimmed !== "" && !/^[1-9]\d*$/.test(trimmed)) {
      toast("error", "The limit must be a whole number above 0, or blank for unlimited.");
      return false;
    }
    return save({ ...policy, rateLimitPerMinute: trimmed === "" ? null : Number(trimmed) }, () =>
      trimmed === "" ? "Rate limit removed — calls are unlimited" : `Rate limit set to ${trimmed} calls per minute per key`,
    );
  };

  const saveRules = (): Promise<boolean> =>
    save({ ...policy, allow: linesToList(allowText), deny: linesToList(denyText) }, (changed) =>
      changed === 0 ? "Rules saved — no tool changed status" : `Rules saved — ${changed} tool${changed === 1 ? "" : "s"} changed status`,
    );

  const byNamespace = new Map<string, ToolInfo[]>();
  for (const t of tools) {
    const ns = t.name.split(".")[0] ?? "";
    byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), t]);
  }
  const blockedCount = tools.filter((t) => t.verdict === "deny").length;
  const limitDirty = limit.trim() !== (policy.rateLimitPerMinute === null ? "" : String(policy.rateLimitPerMinute));
  const rulesDirty = allowText !== policy.allow.join("\n") || denyText !== policy.deny.join("\n");

  return (
    <>
      <div className="tiles three">
        <Tile label="Tools available" value={tools.length - blockedCount} tone="allow" hint={`of ${tools.length}`} />
        <Tile label="Tools blocked" value={blockedCount} tone="deny" />
        <Tile label="Rate limit" value={policy.rateLimitPerMinute === null ? "None" : `${policy.rateLimitPerMinute}/min`} tone="throttle" hint="per API key" />
      </div>

      <div className="split">
        <Card title="Tools" subtitle={`${tools.length} tools from ${byNamespace.size} upstream servers. Changes apply to the next call.`} className="grow-card">
          {[...byNamespace.entries()].map(([ns, list]) => (
            <div key={ns} className="tool-group">
              <h3 className="mono">{ns}</h3>
              <ul className="tool-list">
                {list.map((t) => {
                  const explicit = policy.deny.includes(t.name);
                  // Blocked by a pattern or the allowlist, not by its own switch: the switch can't undo that.
                  const lockedByRule = t.verdict === "deny" && !explicit;
                  const classes = ["tool", t.verdict === "deny" ? "blocked" : "", flash.has(t.name) ? "flash" : ""].join(" ");
                  return (
                    <li key={t.name} className={classes}>
                      <div className="tool-text">
                        <span className="mono tool-name">{t.name}</span>
                        <span className="muted tool-desc" title={lockedByRule ? (t.reason ?? "") : t.description}>
                          {lockedByRule ? t.reason : t.description}
                        </span>
                      </div>
                      <label className={lockedByRule ? "switch disabled" : "switch"} title={lockedByRule ? "Blocked by an advanced rule" : undefined}>
                        <input
                          type="checkbox"
                          checked={t.verdict === "allow"}
                          disabled={lockedByRule || busyTool === t.name}
                          onChange={() => void toggle(t)}
                          aria-label={`${t.verdict === "allow" ? "Block" : "Allow"} ${t.name}`}
                        />
                        <span className="track" />
                        <span className="switch-label">{busyTool === t.name ? "Saving…" : t.verdict === "allow" ? "Allowed" : "Blocked"}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </Card>

        <div className="stack">
          <Card title="Rate limit" subtitle="Maximum tool calls per minute, for each API key.">
            <div className="row">
              <input className="input narrow" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" aria-label="Calls per minute" />
              <span className="muted">calls / min</span>
            </div>
            <div className="row actions-row">
              <SaveButton onSave={saveLimit}>Save limit</SaveButton>
              {limitDirty && <span className="unsaved">Unsaved change</span>}
            </div>
          </Card>

          <Card title="Advanced rules" subtitle={<>Patterns: <code>*</code> all tools, <code>fs.*</code> a whole server, or an exact name. Deny always wins.</>}>
            <label className="field">
              <span>Allow only these (empty = allow everything)</span>
              <textarea value={allowText} onChange={(e) => setAllowText(e.target.value)} placeholder={"everything.*\nfs.read_file"} />
            </label>
            <label className="field">
              <span>Always block these</span>
              <textarea value={denyText} onChange={(e) => setDenyText(e.target.value)} placeholder="fs.write_file" />
            </label>
            <div className="row actions-row">
              <SaveButton onSave={saveRules}>Save rules</SaveButton>
              {rulesDirty && <span className="unsaved">Unsaved changes</span>}
            </div>

            <div className="active-rules">
              <span className="muted small-label">Active now</span>
              {policy.allow.length === 0 && policy.deny.length === 0 ? (
                <span className="muted">No rules — every tool is allowed.</span>
              ) : (
                <div className="rule-chips">
                  {policy.allow.map((p) => (
                    <span key={`a-${p}`} className="rule-chip allow">allow {p}</span>
                  ))}
                  {policy.deny.map((p) => (
                    <span key={`d-${p}`} className="rule-chip deny">block {p}</span>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- keys */

function KeysPanel() {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const now = useNow(30_000);

  const load = useCallback(() => api.keys().then(setKeys).catch(() => toast("error", "Could not load keys.")), [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (name.trim() === "") {
      toast("error", "Give the key a name, such as “Cursor on my laptop”.");
      return;
    }
    try {
      const result = await api.createKey(name.trim());
      setCreated({ key: result.key, name: result.apiKey.name });
      setName("");
      toast("success", `Key “${result.apiKey.name}” created`);
      await load();
    } catch (err) {
      toast("error", errorText(err, "Could not create the key."));
    }
  };

  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke “${k.name}”? Any agent using it is refused immediately. This cannot be undone.`)) return;
    try {
      await api.revokeKey(k.id);
      toast("success", `Key “${k.name}” revoked`);
    } catch {
      toast("error", "Could not revoke the key.");
    }
    await load();
  };

  const active = (keys ?? []).filter((k) => k.revokedAt === null);
  const revoked = (keys ?? []).filter((k) => k.revokedAt !== null);

  return (
    <>
      {created !== null && (
        <div className="reveal card">
          <div>
            <h2>Copy your new key now</h2>
            <p className="muted">
              This is the only time “{created.name}” will be shown. Warden stores only a fingerprint of it, so a lost key can't be recovered — revoke it and make another.
            </p>
          </div>
          <div className="secret">
            <code className="mono">{created.key}</code>
            <CopyButton text={created.key} />
          </div>
          <button className="btn ghost small" onClick={() => setCreated(null)}>
            I've saved it
          </button>
        </div>
      )}

      <Card title="Create a key" subtitle="One key per agent or machine, so you can revoke one without breaking the others.">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input className="input grow" placeholder="Key name, e.g. Cursor on my laptop" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" type="submit">
            Create key
          </button>
        </form>
      </Card>

      <Card title="Active keys" subtitle={keys === null ? "Loading…" : `${active.length} active`}>
        {keys !== null && active.length === 0 ? <p className="empty muted">No active keys. Create one above.</p> : <KeyTable keys={active} now={now} onRevoke={(k) => void revoke(k)} />}
      </Card>

      {revoked.length > 0 && (
        <Card title="Revoked" subtitle="Kept so the call history still shows which key made each call.">
          <KeyTable keys={revoked} now={now} />
        </Card>
      )}
    </>
  );
}

function KeyTable({ keys, now, onRevoke }: { keys: ApiKey[]; now: number; onRevoke?: (k: ApiKey) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th className="right">{onRevoke === undefined ? "Revoked" : ""}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td className="mono muted">{k.prefix}…</td>
              <td className="muted" title={new Date(k.createdAt).toLocaleString()}>
                {ago(k.createdAt, now)}
              </td>
              <td className="right">
                {onRevoke !== undefined ? (
                  <button className="btn danger small" onClick={() => onRevoke(k)}>
                    Revoke
                  </button>
                ) : (
                  <span className="muted">{k.revokedAt !== null ? ago(k.revokedAt, now) : ""}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- connect */

function ConnectPanel() {
  const config = JSON.stringify({ mcpServers: { warden: { url: MCP_URL, headers: { Authorization: "Bearer wdn_YOUR_KEY_HERE" } } } }, null, 2);

  return (
    <div className="split even">
      <div className="stack">
        <Card title="Endpoint" subtitle="Agents connect over Streamable HTTP, with an API key in the Authorization header.">
          <div className="secret">
            <code className="mono">{MCP_URL}</code>
            <CopyButton text={MCP_URL} />
          </div>
        </Card>
        <Card title="Try it with the MCP Inspector">
          <ol className="steps">
            <li>
              Run <code>npx @modelcontextprotocol/inspector@latest</code>
            </li>
            <li>
              Add a server: transport <strong>Streamable HTTP</strong>, URL <code>{MCP_URL}</code>
            </li>
            <li>
              Add the header <code>Authorization</code> with the value <code>Bearer wdn_…</code>
            </li>
            <li>Connect, open Tools, and run any tool — it appears on the Overview within 2 seconds.</li>
          </ol>
        </Card>
      </div>
      <Card title="Client configuration" subtitle="Most MCP clients that support remote servers accept a block like this. Replace the key with one from API keys.">
        <div className="code-block">
          <pre className="mono">{config}</pre>
          <CopyButton text={config} />
        </div>
      </Card>
    </div>
  );
}
