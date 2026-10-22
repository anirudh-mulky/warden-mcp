import { useMemo, useState } from "react";
import type { ApiKey, Approval } from "@warden/shared";
import { api } from "../api";
import { useToast } from "../Toast";
import { ago, Card, Empty, errorText, Icon, Pill, usePoll, useNow, until } from "../ui";

/**
 * Calls waiting for a human. Each card shows exactly what the agent wants to
 * do (arguments with secrets masked), and how long before it times out.
 */
export function ApprovalsPage({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ pending: Approval[]; recent: Approval[] } | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(1_000);

  usePoll(() => api.approvals().then(setData).catch(() => undefined), 1_500);
  usePoll(() => api.keys().then(setKeys).catch(() => undefined), 30_000);
  const keyName = useMemo(() => new Map(keys.map((k) => [k.id as string, k.name])), [keys]);

  const decide = async (a: Approval, decision: "approved" | "denied") => {
    setBusy(a.id);
    try {
      await api.decide(a.id, decision);
      toast("success", decision === "approved" ? `Approved ${a.tool} — the agent's call is going through` : `Denied ${a.tool} — the agent was told why`);
      setData(await api.approvals());
      onChanged();
    } catch (err) {
      toast("error", errorText(err, "Could not record the decision."));
    } finally {
      setBusy(null);
    }
  };

  if (data === null) return <p className="muted">Loading…</p>;

  return (
    <>
      <Card title="Waiting for you" subtitle="The agent's request is held open until you decide, or it times out." icon={Icon.hand}>
        {data.pending.length === 0 ? (
          <Empty title="Nothing waiting">
            Add tools to <strong>Require approval</strong> on the Policy page, and their calls will pause here for you.
          </Empty>
        ) : (
          <div className="approval-grid">
            {data.pending.map((a) => {
              const total = Date.parse(a.expiresAt) - Date.parse(a.createdAt);
              const left = Math.max(0, Date.parse(a.expiresAt) - now);
              return (
                <div key={a.id} className="glass approval">
                  <div className="approval-head">
                    <span className="mono strong">{a.tool}</span>
                    <Pill tone="throttle">{until(a.expiresAt, now)} left</Pill>
                  </div>
                  <div className="countdown" aria-hidden="true">
                    <span style={{ width: `${(left / total) * 100}%` }} />
                  </div>
                  <p className="muted small">
                    From key <strong>{keyName.get(a.apiKeyId) ?? a.apiKeyId}</strong> · {ago(a.createdAt, now)}
                  </p>
                  <pre className="args mono">{JSON.stringify(a.args, null, 2)}</pre>
                  <div className="row">
                    <button className="btn approve" disabled={busy === a.id} onClick={() => void decide(a, "approved")}>
                      {Icon.check} Approve
                    </button>
                    <button className="btn danger" disabled={busy === a.id} onClick={() => void decide(a, "denied")}>
                      {Icon.ban} Deny
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Recent decisions" icon={Icon.clock}>
        {data.recent.length === 0 ? (
          <Empty title="No decisions yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Outcome</th>
                  <th>Decided by</th>
                  <th>Key</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.tool}</td>
                    <td>
                      <Pill tone={a.status === "approved" ? "allow" : a.status === "denied" ? "deny" : "neutral"}>{a.status}</Pill>
                    </td>
                    <td className="muted">{a.decidedBy ?? (a.status === "expired" ? "nobody — timed out" : "—")}</td>
                    <td className="muted">{keyName.get(a.apiKeyId) ?? a.apiKeyId}</td>
                    <td className="muted">{ago(a.createdAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
