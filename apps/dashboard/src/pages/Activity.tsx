import { useState } from "react";
import type { AuditEntry } from "@warden/shared";
import { api } from "../api";
import { ago, Card, Empty, Icon, usePoll, useNow } from "../ui";

const ACTION_LABEL: Record<string, string> = {
  "account.create": "Created the account",
  "session.login": "Signed in",
  "session.revoke-all": "Signed out everywhere",
  "policy.update": "Changed the policy",
  "policy.reset": "Removed a key's custom policy",
  "key.create": "Created an API key",
  "key.revoke": "Revoked an API key",
  "approval.approve": "Approved a call",
  "approval.deny": "Denied a call",
  "settings.update": "Changed alert settings",
  "upstream.add": "Added a remote server",
  "upstream.remove": "Removed a remote server",
  "calls.export": "Exported the call log",
};

const tone = (action: string) =>
  action.startsWith("policy") ? "accent" : action.includes("revoke") || action.includes("deny") || action.includes("remove") ? "deny" : action.startsWith("approval") ? "allow" : "neutral";

/** Who changed what, and when. The call log says what agents did; this says what people did. */
export function ActivityPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const now = useNow(15_000);
  usePoll(() => api.audit().then(setEntries).catch(() => undefined), 10_000);

  return (
    <Card title="Audit trail" subtitle="Every change made through this dashboard. Kept so you can answer “who loosened that rule?”" icon={Icon.list}>
      {entries === null ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <Empty title="No activity yet" />
      ) : (
        <ol className="audit">
          {entries.map((e) => (
            <li key={e.id} className={`audit-item tone-${tone(e.action)}`}>
              <span className="audit-dot" aria-hidden="true" />
              <div className="audit-body">
                <div className="audit-line">
                  <strong>{ACTION_LABEL[e.action] ?? e.action}</strong>
                  <span className="muted">· {e.target}</span>
                </div>
                {e.detail !== null && <div className="audit-detail mono">{e.detail}</div>}
                <div className="muted small">
                  {e.actor} · <span title={new Date(e.at).toLocaleString()}>{ago(e.at, now)}</span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
