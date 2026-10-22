import { useCallback, useEffect, useState } from "react";
import type { ApiKey } from "@warden/shared";
import { api } from "../api";
import { useToast } from "../Toast";
import { ago, Card, CopyButton, Empty, errorText, Icon, Pill, until, useNow } from "../ui";

const EXPIRY: { label: string; days: number | null }[] = [
  { label: "Never expires", days: null },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

export function KeysPage({ onGoTo }: { onGoTo: (tab: string) => void }) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState<number | null>(90);
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
      const result = await api.createKey(name.trim(), days);
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

  const isExpired = (k: ApiKey) => k.expiresAt !== null && Date.parse(k.expiresAt) <= now;
  const active = (keys ?? []).filter((k) => k.revokedAt === null && !isExpired(k));
  const inactive = (keys ?? []).filter((k) => k.revokedAt !== null || isExpired(k));

  return (
    <>
      {created !== null && (
        <div className="glass reveal">
          <div>
            <h2>Copy your new key now</h2>
            <p className="muted">This is the only time “{created.name}” will be shown. Warden stores only a fingerprint of it, so a lost key can't be recovered — revoke it and make another.</p>
          </div>
          <div className="secret">
            <code className="mono">{created.key}</code>
            <CopyButton text={created.key} />
          </div>
          <div className="row">
            <button className="btn ghost small" onClick={() => setCreated(null)}>
              I've saved it
            </button>
            <button className="btn ghost small" onClick={() => onGoTo("connect")}>
              How to connect →
            </button>
          </div>
        </div>
      )}

      <Card title="Create a key" subtitle="One key per agent or machine, so you can revoke one without breaking the others. Expiring keys limit the damage if one leaks." icon={Icon.key}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input className="input grow" placeholder="Key name, e.g. Cursor on my laptop" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="input select" value={days ?? ""} onChange={(e) => setDays(e.target.value === "" ? null : Number(e.target.value))} aria-label="Expiry">
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.days ?? ""}>
                {x.label}
              </option>
            ))}
          </select>
          <button className="btn primary" type="submit">
            Create key
          </button>
        </form>
      </Card>

      <Card title="Active keys" subtitle={keys === null ? "Loading…" : `${active.length} active`} icon={Icon.check}>
        {keys !== null && active.length === 0 ? (
          <Empty title="No active keys">Create one above.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th className="right" />
                </tr>
              </thead>
              <tbody>
                {active.map((k) => (
                  <tr key={k.id}>
                    <td className="strong">{k.name}</td>
                    <td className="mono muted">{k.prefix}…</td>
                    <td className="muted" title={new Date(k.createdAt).toLocaleString()}>
                      {ago(k.createdAt, now)}
                    </td>
                    <td>{k.expiresAt === null ? <span className="muted">never</span> : <Pill tone={Date.parse(k.expiresAt) - now < 7 * 86_400_000 ? "throttle" : "neutral"}>in {until(k.expiresAt, now)}</Pill>}</td>
                    <td className="right">
                      <button className="btn danger small" onClick={() => void revoke(k)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {inactive.length > 0 && (
        <Card title="Revoked and expired" subtitle="Kept so the call history still shows which key made each call." icon={Icon.ban}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {inactive.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="mono muted">{k.prefix}…</td>
                    <td>{k.revokedAt !== null ? <Pill tone="deny">revoked {ago(k.revokedAt, now)}</Pill> : <Pill>expired</Pill>}</td>
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
