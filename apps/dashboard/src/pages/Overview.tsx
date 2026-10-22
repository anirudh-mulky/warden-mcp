import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiKey, ToolCallRecord, ToolStats, Verdict } from "@warden/shared";
import { api } from "../api";
import { CallsChart } from "../CallsChart";
import { ago, Card, Drawer, Empty, Icon, Pill, Tile, usePoll, useNow, VERDICT_NAME, VerdictBadge } from "../ui";

const FEED_LIMIT = 500;
const POLL_MS = 2_000;

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

export function Overview({ onGoTo, pendingApprovals }: { onGoTo: (tab: string) => void; pendingApprovals: number }) {
  const [stats, setStats] = useState<ToolStats[] | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const { calls, live } = useCalls();
  const now = useNow(5_000);

  usePoll(() => api.stats().then(setStats).catch(() => undefined), 5_000);
  useEffect(() => {
    api.keys().then(setKeys).catch(() => undefined);
  }, []);
  const keyName = useMemo(() => new Map(keys.map((k) => [k.id as string, k.name])), [keys]);

  const totals = useMemo(() => {
    const s = stats ?? [];
    const sum = (f: (x: ToolStats) => number) => s.reduce((a, x) => a + f(x), 0);
    const p95s = s.map((x) => x.p95Ms).filter((v): v is number => v !== null);
    const all = sum((x) => x.calls);
    return {
      calls: all,
      allowed: sum((x) => x.allowed),
      blocked: sum((x) => x.denied),
      throttled: sum((x) => x.throttled),
      refused: all === 0 ? null : Math.round((sum((x) => x.denied + x.throttled) / all) * 100),
      worstP95: p95s.length === 0 ? null : Math.max(...p95s),
    };
  }, [stats]);

  const top = (stats ?? []).slice(0, 6);
  const topMax = Math.max(1, ...top.map((t) => t.calls));

  return (
    <>
      <div className="tiles">
        <Tile label="Total calls" value={totals.calls} hint="last 500" tone="accent" icon={Icon.bolt} />
        <Tile label="Allowed" value={totals.allowed} tone="allow" icon={Icon.check} />
        <Tile label="Blocked" value={totals.blocked} tone="deny" icon={Icon.ban} />
        <Tile label="Throttled" value={totals.throttled} tone="throttle" icon={Icon.gauge} />
        <Tile label="Refused" value={totals.refused === null ? "—" : `${totals.refused}%`} hint="blocked + throttled" tone="warn" icon={Icon.shield} />
        <Tile label="Slowest p95" value={totals.worstP95 === null ? "—" : `${totals.worstP95} ms`} hint="worst tool" tone="accent" icon={Icon.clock} />
      </div>

      {pendingApprovals > 0 && (
        <button className="glass banner-cta" onClick={() => onGoTo("approvals")}>
          <span className="pulse-dot" aria-hidden="true" />
          <strong>{pendingApprovals} call{pendingApprovals === 1 ? " is" : "s are"} waiting for your approval</strong>
          <span className="muted">Review now →</span>
        </button>
      )}

      {stats !== null && stats.length === 0 && (
        <Card className="hero">
          <Empty title="No calls yet">
            Create an API key, connect an MCP client to Warden, and every call will appear here live.
            <div className="row center-row" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={() => onGoTo("keys")}>
                Create a key
              </button>
              <button className="btn ghost" onClick={() => onGoTo("connect")}>
                How to connect
              </button>
            </div>
          </Empty>
        </Card>
      )}

      <div className="split">
        <Card title="Calls per minute" subtitle="Last 30 minutes, by result. Hover a bar for exact counts." icon={Icon.chart}>
          <CallsChart calls={calls} now={now} />
        </Card>
        <Card title="Top tools" subtitle="By calls · p95 latency, excluding time spent waiting for approval" icon={Icon.list}>
          {top.length === 0 ? (
            <Empty title="Nothing yet" />
          ) : (
            <ul className="top-tools">
              {top.map((t) => (
                <li key={t.tool}>
                  <div className="top-row">
                    <span className="mono top-name" title={t.tool}>
                      {t.tool}
                    </span>
                    <span className="num strong">{t.calls}</span>
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

      <LiveFeed calls={calls} live={live} now={now} keyName={keyName} />
    </>
  );
}

function LiveFeed({ calls, live, now, keyName }: { calls: ToolCallRecord[]; live: boolean; now: number; keyName: Map<string, string> }) {
  const [filter, setFilter] = useState<Verdict | "all">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ToolCallRecord | null>(null);
  const firstSeen = useRef<Set<string> | null>(null);
  if (firstSeen.current === null && calls.length > 0) firstSeen.current = new Set(calls.map((c) => c.id));

  const q = query.trim().toLowerCase();
  const shown = calls.filter((c) => (filter === "all" || c.verdict === filter) && (q === "" || c.tool.toLowerCase().includes(q))).slice(0, 100);
  const filters: (Verdict | "all")[] = ["all", "allow", "deny", "throttle", "error"];

  return (
    <Card
      title="Live calls"
      icon={Icon.bolt}
      subtitle={
        <span className="live">
          <span className={live ? "dot on" : "dot"} /> {live ? "Updating every 2 seconds · click a row for details" : "Disconnected — retrying"}
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
          <a className="btn ghost small" href={api.exportUrl("csv")} download>
            {Icon.download} CSV
          </a>
          <a className="btn ghost small" href={api.exportUrl("json")} download>
            {Icon.download} JSON
          </a>
        </div>
      }
    >
      {shown.length === 0 ? (
        <Empty title={calls.length === 0 ? "Waiting for the first tool call…" : "No calls match these filters"} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Result</th>
                <th>Key</th>
                <th className="num">Latency</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className={`clickable ${firstSeen.current !== null && !firstSeen.current.has(c.id) ? "fresh" : ""}`} onClick={() => setOpen(c)}>
                  <td className="muted nowrap" title={new Date(c.startedAt).toLocaleString()}>
                    {ago(c.startedAt, now)}
                  </td>
                  <td className="mono">{c.tool}</td>
                  <td>
                    <span className="row tight">
                      <VerdictBadge verdict={c.verdict} />
                      {c.approval !== undefined && <Pill tone="accent">{c.approval === "approved" ? "approved" : c.approval}</Pill>}
                      {(c.redactions ?? 0) > 0 && <Pill tone="throttle">{c.redactions} masked</Pill>}
                    </span>
                  </td>
                  <td className="muted nowrap">{keyName.get(c.apiKeyId) ?? c.apiKeyId}</td>
                  <td className="num">{c.latencyMs} ms</td>
                  <td className="muted reason">{c.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer open={open !== null} onClose={() => setOpen(null)} title="Call details">
        {open !== null && <CallDetail call={open} keyName={keyName.get(open.apiKeyId)} />}
      </Drawer>
    </Card>
  );
}

function CallDetail({ call, keyName }: { call: ToolCallRecord; keyName: string | undefined }) {
  const start = Date.parse(call.startedAt);
  const rows: [string, React.ReactNode][] = [
    ["Tool", <span className="mono">{call.tool}</span>],
    ["Result", <VerdictBadge verdict={call.verdict} />],
    ["Reason", call.reason ?? <span className="muted">—</span>],
    ["API key", keyName !== undefined ? `${keyName} (${call.apiKeyId})` : call.apiKeyId],
    ["Upstream", call.upstreamId ?? <span className="muted">not forwarded</span>],
    ["Started", new Date(call.startedAt).toLocaleString()],
    ["Latency", `${call.latencyMs} ms`],
    ["Approval", call.approval ?? <span className="muted">not required</span>],
    ["Secrets masked", String(call.redactions ?? 0)],
    ["Arguments hash", <code className="mono wrap">{call.argsHash}</code>],
    ["Call id", <code className="mono wrap">{call.id}</code>],
  ];
  // Only times Warden actually measured: the start, and the end (start + latency).
  // The moment of an approval decision isn't recorded on the call, so it gets no time.
  const steps: { label: string; at: number | null }[] = [
    { label: "Request received, key checked", at: start },
    ...(call.approval !== undefined ? [{ label: `Approval: ${call.approval}`, at: null }] : []),
    {
      label: call.verdict === "allow" ? `Forwarded to ${call.upstreamId ?? "upstream"} and answered` : call.verdict === "error" ? "Failed" : `Refused (${VERDICT_NAME[call.verdict].toLowerCase()})`,
      at: start + call.latencyMs,
    },
  ];
  return (
    <div className="detail">
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3>Timeline</h3>
      <ol className="timeline">
        {steps.map((s, i) => (
          <li key={i} className={i === steps.length - 1 ? `end ${call.verdict}` : ""}>
            <span className="tl-dot" />
            <span>{s.label}</span>
            <span className="muted mono">{s.at === null ? "" : `+${Math.round(s.at - start)} ms`}</span>
          </li>
        ))}
      </ol>
      <p className="muted small">Warden stores a fingerprint of the arguments, never the arguments themselves — they may contain secrets.</p>
    </div>
  );
}
