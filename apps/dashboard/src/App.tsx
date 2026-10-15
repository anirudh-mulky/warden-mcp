import { useEffect, useState } from "react";
import type { Policy, ToolCallRecord, ToolStats } from "@warden/shared";
import { api, ApiError, streamCalls } from "./api";

const KEY_STORAGE = "warden.apiKey";
const FEED_LIMIT = 200;

function loadKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function saveKey(key: string): void {
  try {
    if (key === "") sessionStorage.removeItem(KEY_STORAGE);
    else sessionStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Storage blocked (private mode): the key just won't survive a reload.
  }
}

export function App() {
  const [key, setKey] = useState(loadKey);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (key === "") return;
    api
      .me(key)
      .then((me) => {
        setTenantId(me.tenantId);
        setError(null);
      })
      .catch((err: unknown) => {
        setTenantId(null);
        setError(err instanceof ApiError && err.status === 401 ? "That key was rejected." : "Cannot reach the gateway.");
      });
  }, [key]);

  const signOut = () => {
    saveKey("");
    setKey("");
    setTenantId(null);
  };

  if (key === "" || tenantId === null) {
    return (
      <KeyPrompt
        error={error}
        onSubmit={(k) => {
          saveKey(k);
          setKey(k);
        }}
      />
    );
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Warden</h1>
        <span className="muted">tenant {tenantId}</span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <PolicyEditor apiKey={key} />
      <Stats apiKey={key} />
      <LiveFeed apiKey={key} />
    </main>
  );
}

function KeyPrompt({ error, onSubmit }: { error: string | null; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <main className="page narrow">
      <h1>Warden</h1>
      <p className="muted">Enter an API key to see its tenant's calls and policy.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() !== "") onSubmit(value.trim());
        }}
      >
        <input
          className="input"
          type="password"
          placeholder="wdn_…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button className="button" type="submit">
          Open dashboard
        </button>
      </form>
      {error !== null && <p className="error">{error}</p>}
    </main>
  );
}

function linesToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function PolicyEditor({ apiKey }: { apiKey: string }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [limit, setLimit] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const fill = (p: Policy) => {
    setPolicy(p);
    setAllow(p.allow.join("\n"));
    setDeny(p.deny.join("\n"));
    setLimit(p.rateLimitPerMinute === null ? "" : String(p.rateLimitPerMinute));
  };

  useEffect(() => {
    api.policy(apiKey).then(fill).catch(() => setStatus("Could not load policy."));
  }, [apiKey]);

  const save = async () => {
    const trimmed = limit.trim();
    if (trimmed !== "" && !/^[1-9]\d*$/.test(trimmed)) {
      setStatus("Rate limit must be a whole number above 0, or blank for unlimited.");
      return;
    }
    try {
      const saved = await api.savePolicy(apiKey, {
        allow: linesToList(allow),
        deny: linesToList(deny),
        rateLimitPerMinute: trimmed === "" ? null : Number(trimmed),
      });
      fill(saved);
      setStatus("Saved. Applies to the next call.");
    } catch (err) {
      setStatus(err instanceof ApiError && err.status === 400 ? `Rejected: ${err.message}` : "Save failed.");
    }
  };

  return (
    <section className="card">
      <h2>Policy</h2>
      {policy === null ? (
        <p className="muted">{status ?? "Loading…"}</p>
      ) : (
        <>
          <div className="grid">
            <label>
              <span>Allow (empty = everything)</span>
              <textarea value={allow} onChange={(e) => setAllow(e.target.value)} placeholder={"everything.*\nfs.read_file"} />
            </label>
            <label>
              <span>Deny (always wins)</span>
              <textarea value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="fs.write_file" />
            </label>
            <label>
              <span>Calls per minute per key (blank = unlimited)</span>
              <input className="input" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="60" />
            </label>
          </div>
          <div className="row">
            <button className="button" onClick={() => void save()}>
              Save policy
            </button>
            {status !== null && <span className="muted">{status}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function Stats({ apiKey }: { apiKey: string }) {
  const [stats, setStats] = useState<ToolStats[]>([]);

  useEffect(() => {
    const load = () => api.stats(apiKey).then(setStats).catch(() => undefined);
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [apiKey]);

  const ms = (v: number | null) => (v === null ? "—" : `${v} ms`);

  return (
    <section className="card">
      <h2>Tools (last 500 calls)</h2>
      {stats.length === 0 ? (
        <p className="muted">No calls yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Calls</th>
              <th>Allowed</th>
              <th>Denied</th>
              <th>Throttled</th>
              <th>Errors</th>
              <th>p50</th>
              <th>p95</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.tool}>
                <td className="mono">{s.tool}</td>
                <td>{s.calls}</td>
                <td>{s.allowed}</td>
                <td>{s.denied}</td>
                <td>{s.throttled}</td>
                <td>{s.errors}</td>
                <td>{ms(s.p50Ms)}</td>
                <td>{ms(s.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LiveFeed({ apiKey }: { apiKey: string }) {
  const [calls, setCalls] = useState<ToolCallRecord[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stop = () => {};
    api
      .calls(apiKey)
      .then(setCalls)
      .catch(() => undefined)
      .finally(() => {
        setLive(true);
        stop = streamCalls(
          apiKey,
          (call) => setCalls((prev) => [call, ...prev].slice(0, FEED_LIMIT)),
          () => setLive(false),
        );
      });
    return () => stop();
  }, [apiKey]);

  return (
    <section className="card">
      <h2>
        Live calls <span className={live ? "dot on" : "dot"} title={live ? "connected" : "disconnected"} />
      </h2>
      {calls.length === 0 ? (
        <p className="muted">Waiting for the first tools/call…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Tool</th>
              <th>Verdict</th>
              <th>Latency</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td className="mono">{new Date(c.startedAt).toLocaleTimeString()}</td>
                <td className="mono">{c.tool}</td>
                <td>
                  <span className={`badge ${c.verdict}`}>{c.verdict}</span>
                </td>
                <td>{c.latencyMs} ms</td>
                <td className="muted">{c.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
