import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiKey, Me, Policy, ToolCallRecord, ToolInfo, ToolStats, Verdict } from "@warden/shared";
import { api, ApiError } from "./api";

const FEED_LIMIT = 200;
const POLL_MS = 2_000;

/** Where agents connect. In local dev the dashboard (5173) and gateway (8080) are separate servers. */
const MCP_URL = location.port === "5173" ? "http://localhost:8080/mcp" : `${location.origin}/mcp`;

type Tab = "overview" | "policy" | "keys" | "connect";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "policy", label: "Policy" },
  { id: "keys", label: "API keys" },
  { id: "connect", label: "Connect" },
];

/* ------------------------------------------------------------------ helpers */

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

const VERDICT_LABEL: Record<Verdict, string> = { allow: "allowed", deny: "blocked", throttle: "throttled", error: "error" };

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`badge ${verdict}`}>{VERDICT_LABEL[verdict]}</span>;
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
      {done ? "Copied" : label}
    </button>
  );
}

function Card({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
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

/* --------------------------------------------------------------------- app */

function currentTab(): Tab {
  const hash = location.hash.slice(1);
  return TABS.some((t) => t.id === hash) ? (hash as Tab) : "overview";
}

export function App() {
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="logo" aria-hidden="true">W</span>
            Warden
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={tab === t.id ? "tab active" : "tab"} aria-current={tab === t.id ? "page" : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
          <div className="account">
            <span className="muted email">{me.email}</span>
            <span className="pill mono" title="Your tenant id">{me.tenantId}</span>
            <button className="btn ghost small" onClick={() => void api.logout().finally(() => setMe(null))}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="page">
        {tab === "overview" && <Overview onGoTo={(t) => (location.hash = t)} />}
        {tab === "policy" && <PolicyPanel />}
        {tab === "keys" && <KeysPanel />}
        {tab === "connect" && <ConnectPanel />}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------- auth */

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
            <span>Sign-up code <em className="muted">(only if this server requires one)</em></span>
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

/* ---------------------------------------------------------------- overview */

function Overview({ onGoTo }: { onGoTo: (tab: Tab) => void }) {
  const [stats, setStats] = useState<ToolStats[] | null>(null);

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
    return {
      calls: sum((x) => x.calls),
      allowed: sum((x) => x.allowed),
      blocked: sum((x) => x.denied),
      throttled: sum((x) => x.throttled),
      worstP95: p95s.length === 0 ? null : Math.max(...p95s),
    };
  }, [stats]);

  return (
    <>
      <div className="tiles">
        <Tile label="Calls" value={totals.calls} hint="last 500" />
        <Tile label="Allowed" value={totals.allowed} tone="allow" />
        <Tile label="Blocked" value={totals.blocked} tone="deny" />
        <Tile label="Throttled" value={totals.throttled} tone="throttle" />
        <Tile label="Slowest p95" value={totals.worstP95 === null ? "—" : `${totals.worstP95} ms`} hint="worst tool" />
      </div>

      {stats !== null && stats.length === 0 && (
        <div className="empty-hero card">
          <h2>No calls yet</h2>
          <p className="muted">Create an API key, connect an MCP client to Warden, and calls will appear here live.</p>
          <div className="row">
            <button className="btn primary" onClick={() => onGoTo("keys")}>
              Create a key
            </button>
            <button className="btn ghost" onClick={() => onGoTo("connect")}>
              How to connect
            </button>
          </div>
        </div>
      )}

      <LiveFeed />

      {stats !== null && stats.length > 0 && (
        <Card title="By tool" subtitle="Latency percentiles are over allowed calls only, measured at the gateway.">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th className="num">Calls</th>
                  <th className="num">Allowed</th>
                  <th className="num">Blocked</th>
                  <th className="num">Throttled</th>
                  <th className="num">Errors</th>
                  <th className="num">p50</th>
                  <th className="num">p95</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.tool}>
                    <td className="mono">{s.tool}</td>
                    <td className="num">{s.calls}</td>
                    <td className="num">{s.allowed}</td>
                    <td className="num">{s.denied}</td>
                    <td className="num">{s.throttled}</td>
                    <td className="num">{s.errors}</td>
                    <td className="num">{s.p50Ms === null ? "—" : `${s.p50Ms} ms`}</td>
                    <td className="num">{s.p95Ms === null ? "—" : `${s.p95Ms} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: Verdict }) {
  return (
    <div className={`tile ${tone ?? ""}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {hint !== undefined && <span className="tile-hint">{hint}</span>}
    </div>
  );
}

/**
 * Live feed by polling: every 2s, ask for calls newer than the newest one we
 * have. Polling works identically however many gateway instances run, where a
 * long-held stream would only see the instance it happened to connect to.
 */
function LiveFeed() {
  const [calls, setCalls] = useState<ToolCallRecord[]>([]);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState<Verdict | "all">("all");
  const newest = useRef<string | undefined>(undefined);
  const now = useNow(5_000);

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

  const shown = filter === "all" ? calls : calls.filter((c) => c.verdict === filter);
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
        <div className="chips" role="group" aria-label="Filter by verdict">
          {filters.map((f) => (
            <button key={f} className={filter === f ? "chip active" : "chip"} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : VERDICT_LABEL[f]}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? (
        <p className="empty muted">{calls.length === 0 ? "Waiting for the first tool call…" : "No calls match this filter."}</p>
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
                <tr key={c.id}>
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

/* ------------------------------------------------------------------ policy */

function linesToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function PolicyPanel() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [limit, setLimit] = useState("");
  const [allowText, setAllowText] = useState("");
  const [denyText, setDenyText] = useState("");
  const [busyTool, setBusyTool] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [p, t] = await Promise.all([api.policy(), api.tools()]);
    setPolicy(p);
    setTools(t);
    setLimit(p.rateLimitPerMinute === null ? "" : String(p.rateLimitPerMinute));
    setAllowText(p.allow.join("\n"));
    setDenyText(p.deny.join("\n"));
  }, []);

  useEffect(() => {
    reload().catch(() => setStatus({ kind: "error", text: "Could not load the policy." }));
  }, [reload]);

  /** Every change is saved straight away; the server then tells us the new verdict for each tool. */
  const save = async (next: Pick<Policy, "allow" | "deny" | "rateLimitPerMinute">, message: string) => {
    try {
      await api.savePolicy(next);
      await reload();
      setStatus({ kind: "ok", text: message });
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err, "Save failed.") });
    }
  };

  if (policy === null) return <p className="muted">{status?.text ?? "Loading…"}</p>;

  const toggle = async (tool: ToolInfo) => {
    setBusyTool(tool.name);
    const blocked = policy.deny.includes(tool.name);
    const deny = blocked ? policy.deny.filter((d) => d !== tool.name) : [...policy.deny, tool.name];
    await save({ ...policy, deny }, blocked ? `${tool.name} unblocked.` : `${tool.name} blocked.`);
    setBusyTool(null);
  };

  const saveLimit = async () => {
    const trimmed = limit.trim();
    if (trimmed !== "" && !/^[1-9]\d*$/.test(trimmed)) {
      setStatus({ kind: "error", text: "The limit must be a whole number above 0, or blank for unlimited." });
      return;
    }
    await save({ ...policy, rateLimitPerMinute: trimmed === "" ? null : Number(trimmed) }, trimmed === "" ? "Rate limit removed." : `Limit set to ${trimmed} calls per minute per key.`);
  };

  const byNamespace = new Map<string, ToolInfo[]>();
  for (const t of tools) {
    const ns = t.name.split(".")[0] ?? "";
    byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), t]);
  }
  const blockedCount = tools.filter((t) => t.verdict === "deny").length;

  return (
    <>
      {status !== null && <div className={`banner ${status.kind}`}>{status.text}</div>}

      <Card title="Rate limit" subtitle="Maximum tool calls per minute, for each API key. Blank means unlimited.">
        <div className="row">
          <input className="input narrow" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" />
          <span className="muted">calls / minute / key</span>
          <button className="btn primary" onClick={() => void saveLimit()}>
            Save limit
          </button>
        </div>
      </Card>

      <Card title="Tools" subtitle={`${tools.length} tools from ${byNamespace.size} upstream servers · ${blockedCount} blocked. Changes apply to the next call.`}>
        {[...byNamespace.entries()].map(([ns, list]) => (
          <div key={ns} className="tool-group">
            <h3 className="mono">{ns}</h3>
            <ul className="tool-list">
              {list.map((t) => {
                const explicit = policy.deny.includes(t.name);
                // Blocked by a pattern or the allowlist, not by its own switch: the switch can't undo that.
                const lockedByRule = t.verdict === "deny" && !explicit;
                return (
                  <li key={t.name} className={t.verdict === "deny" ? "tool blocked" : "tool"}>
                    <div className="tool-text">
                      <span className="mono tool-name">{t.name}</span>
                      <span className="muted tool-desc">{lockedByRule ? t.reason : t.description}</span>
                    </div>
                    <label className={lockedByRule ? "switch disabled" : "switch"} title={lockedByRule ? "Blocked by an advanced rule below" : undefined}>
                      <input
                        type="checkbox"
                        checked={t.verdict === "allow"}
                        disabled={lockedByRule || busyTool === t.name}
                        onChange={() => void toggle(t)}
                        aria-label={`${t.verdict === "allow" ? "Block" : "Allow"} ${t.name}`}
                      />
                      <span className="track" />
                      <span className="switch-label">{t.verdict === "allow" ? "Allowed" : "Blocked"}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </Card>

      <details className="card advanced">
        <summary>
          <h2>Advanced rules</h2>
          <span className="muted">Patterns: <code>*</code> every tool, <code>fs.*</code> a whole server, or an exact name. Deny always wins.</span>
        </summary>
        <div className="grid two">
          <label className="field">
            <span>Allow only these (empty = allow everything)</span>
            <textarea value={allowText} onChange={(e) => setAllowText(e.target.value)} placeholder={"everything.*\nfs.read_file"} />
          </label>
          <label className="field">
            <span>Always block these</span>
            <textarea value={denyText} onChange={(e) => setDenyText(e.target.value)} placeholder="fs.write_file" />
          </label>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => void save({ ...policy, allow: linesToList(allowText), deny: linesToList(denyText) }, "Rules saved.")}>
            Save rules
          </button>
        </div>
      </details>
    </>
  );
}

/* -------------------------------------------------------------------- keys */

function KeysPanel() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);

  const load = useCallback(() => api.keys().then(setKeys).catch(() => setError("Could not load keys.")), []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (name.trim() === "") {
      setError("Give the key a name, such as “Cursor on my laptop”.");
      return;
    }
    try {
      const result = await api.createKey(name.trim());
      setCreated({ key: result.key, name: result.apiKey.name });
      setName("");
      setError(null);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not create the key."));
    }
  };

  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke “${k.name}”? Any agent using it is refused immediately. This cannot be undone.`)) return;
    await api.revokeKey(k.id).catch(() => setError("Could not revoke the key."));
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
        {error !== null && <p className="error">{error}</p>}
      </Card>

      <Card title="Active keys" subtitle={keys === null ? "Loading…" : `${active.length} active`}>
        {keys !== null && active.length === 0 ? (
          <p className="empty muted">No active keys. Create one above.</p>
        ) : (
          <KeyTable keys={active} now={now} onRevoke={(k) => void revoke(k)} />
        )}
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
            <th>{onRevoke === undefined ? "Revoked" : ""}</th>
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

/* ----------------------------------------------------------------- connect */

function ConnectPanel() {
  const config = JSON.stringify(
    { mcpServers: { warden: { url: MCP_URL, headers: { Authorization: "Bearer wdn_YOUR_KEY_HERE" } } } },
    null,
    2,
  );

  return (
    <>
      <Card title="Endpoint" subtitle="Agents connect here over Streamable HTTP, with an API key in the Authorization header.">
        <div className="secret">
          <code className="mono">{MCP_URL}</code>
          <CopyButton text={MCP_URL} />
        </div>
      </Card>

      <Card title="Client configuration" subtitle="Most MCP clients that support remote servers accept a block like this. Replace the key with one from the API keys tab.">
        <div className="code-block">
          <pre className="mono">{config}</pre>
          <CopyButton text={config} />
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
          <li>Connect, open Tools, and run any tool — it appears on the Overview tab within 2 seconds.</li>
        </ol>
      </Card>
    </>
  );
}
