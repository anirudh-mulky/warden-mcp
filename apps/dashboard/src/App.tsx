import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Me } from "@warden/shared";
import { api } from "./api";
import { ActivityPage } from "./pages/Activity";
import { ApprovalsPage } from "./pages/Approvals";
import { ConnectPage } from "./pages/Connect";
import { KeysPage } from "./pages/Keys";
import { Overview } from "./pages/Overview";
import { PolicyPage } from "./pages/Policy";
import { SettingsPage } from "./pages/Settings";
import { UpstreamsPage } from "./pages/Upstreams";
import { ToastProvider } from "./Toast";
import { errorText, Icon, usePoll } from "./ui";

type Tab = "overview" | "approvals" | "policy" | "keys" | "upstreams" | "activity" | "settings" | "connect";

interface PageDef {
  id: Tab;
  label: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  group: "Monitor" | "Control" | "Configure";
}

const PAGES: PageDef[] = [
  { id: "overview", label: "Overview", title: "Overview", subtitle: "Every tool call your agents make, as it happens.", icon: Icon.chart, group: "Monitor" },
  { id: "approvals", label: "Approvals", title: "Approvals", subtitle: "Calls waiting for a human to say yes or no.", icon: Icon.hand, group: "Monitor" },
  { id: "activity", label: "Audit trail", title: "Audit trail", subtitle: "Who changed what, and when.", icon: Icon.list, group: "Monitor" },
  { id: "policy", label: "Policy", title: "Policy", subtitle: "Decide what your agents may do — per tool, per argument, per key.", icon: Icon.shield, group: "Control" },
  { id: "keys", label: "API keys", title: "API keys", subtitle: "Credentials your agents use to connect to Warden.", icon: Icon.key, group: "Control" },
  { id: "upstreams", label: "Servers", title: "MCP servers", subtitle: "The tool servers behind Warden.", icon: Icon.server, group: "Configure" },
  { id: "settings", label: "Alerts & security", title: "Alerts & security", subtitle: "Notifications and session control.", icon: Icon.bell, group: "Configure" },
  { id: "connect", label: "Connect", title: "Connect an agent", subtitle: "Point any MCP client at Warden in under a minute.", icon: Icon.plug, group: "Configure" },
];

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
  const [pending, setPending] = useState(0);

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

  const refreshPending = useCallback(() => {
    if (me !== null) void api.approvalCount().then((r) => setPending(r.pending)).catch(() => undefined);
  }, [me]);
  usePoll(refreshPending, 3_000, [refreshPending]);

  if (checking) return <div className="center muted">Loading…</div>;
  if (me === null) return <AuthScreen onSignedIn={setMe} />;

  const page = PAGES.find((p) => p.id === tab) ?? PAGES[0]!;
  const goTo = (t: string) => (location.hash = t);
  const groups = ["Monitor", "Control", "Configure"] as const;

  return (
    <div className="app">
      <aside className="glass sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true">W</span>
          <span>Warden</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {groups.map((g) => (
            <div key={g} className="nav-group">
              <span className="nav-heading">{g}</span>
              {PAGES.filter((p) => p.group === g).map((p) => (
                <a key={p.id} href={`#${p.id}`} className={tab === p.id ? "nav-item active" : "nav-item"} aria-current={tab === p.id ? "page" : undefined}>
                  {p.icon}
                  <span>{p.label}</span>
                  {p.id === "approvals" && pending > 0 && <span className="nav-badge">{pending}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <span className="avatar" aria-hidden="true">{me.email.slice(0, 1).toUpperCase()}</span>
            <div className="who-text">
              <span className="who-email" title={me.email}>
                {me.email}
              </span>
              <span className="mono muted who-tenant" title="Your tenant id">
                {me.tenantId}
              </span>
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
            <h1 className="gradient-text">{page.title}</h1>
            <p className="muted">{page.subtitle}</p>
          </div>
          <HealthPill />
        </header>
        <div className="content" key={tab}>
          {tab === "overview" && <Overview onGoTo={goTo} pendingApprovals={pending} />}
          {tab === "approvals" && <ApprovalsPage onChanged={refreshPending} />}
          {tab === "activity" && <ActivityPage />}
          {tab === "policy" && <PolicyPage />}
          {tab === "keys" && <KeysPage onGoTo={goTo} />}
          {tab === "upstreams" && <UpstreamsPage />}
          {tab === "settings" && <SettingsPage onSignedOut={() => setMe(null)} />}
          {tab === "connect" && <ConnectPage />}
        </div>
      </div>
    </div>
  );
}

/** Gateway status from /readyz: ready, degraded (some upstreams down), or unavailable. */
function HealthPill() {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  usePoll(() => api.health().then(setHealth).catch(() => setHealth(null)), 10_000);
  if (health === null) return <span className="glass health unknown">Gateway unreachable</span>;
  const up = health.upstreams.filter((u) => u.status === "connected").length;
  const label = health.status === "ready" ? "All systems normal" : health.status === "degraded" ? "Degraded" : "Unavailable";
  return (
    <span className={`glass health ${health.status}`} title={health.upstreams.map((u) => `${u.namespace}: ${u.status}`).join("\n")}>
      <span className="health-dot" aria-hidden="true" />
      {label} · {up}/{health.upstreams.length} servers
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
        <h1>
          The control plane between your <span className="gradient-text">AI agents</span> and their tools.
        </h1>
        <ul className="pitch-list">
          <li>Allow, block or require approval — per tool, per argument, per key</li>
          <li>Mask secrets before the model ever sees them</li>
          <li>Watch every call live, with alerts when something spikes</li>
        </ul>
      </div>
      <form
        className="glass auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
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
