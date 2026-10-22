import { useEffect, useState } from "react";
import type { TenantSettings } from "@warden/shared";
import { api } from "../api";
import { useToast } from "../Toast";
import { Card, errorText, Icon, SaveButton, Switch } from "../ui";

export function SettingsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<TenantSettings | null>(null);
  const [url, setUrl] = useState("");
  const [threshold, setThreshold] = useState("10");

  useEffect(() => {
    api
      .settings()
      .then((v) => {
        setS(v);
        setUrl(v.webhookUrl ?? "");
        setThreshold(String(v.blockedSpikeThreshold));
      })
      .catch(() => toast("error", "Could not load settings."));
  }, [toast]);

  if (s === null) return <p className="muted">Loading…</p>;

  const save = async (patch: Partial<TenantSettings>, message: string): Promise<boolean> => {
    const n = Number(threshold);
    if (!Number.isInteger(n) || n < 1) {
      toast("error", "The spike threshold must be a whole number above 0.");
      return false;
    }
    try {
      const next = await api.saveSettings({
        webhookUrl: url.trim() === "" ? null : url.trim(),
        alertOnBlockedSpike: s.alertOnBlockedSpike,
        alertOnUpstreamDown: s.alertOnUpstreamDown,
        blockedSpikeThreshold: n,
        ...patch,
      });
      setS(next);
      toast("success", message);
      return true;
    } catch (err) {
      toast("error", errorText(err, "Save failed."));
      return false;
    }
  };

  return (
    <>
      <Card title="Alerts" subtitle="Get a message in Discord or Slack when something needs attention. Paste an incoming-webhook URL." icon={Icon.bell}>
        <label className="field">
          <span>Webhook URL</span>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" />
        </label>
        <div className="toggle-row">
          <div>
            <strong>Spike in blocked calls</strong>
            <p className="muted small">
              Alert when at least
              <input className="input inline-num" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="Blocked calls threshold" />
              calls are blocked within 5 minutes — at most once every 10 minutes.
            </p>
          </div>
          <Switch checked={s.alertOnBlockedSpike} label="Alert on blocked spike" onChange={(v) => void save({ alertOnBlockedSpike: v }, v ? "Spike alerts on" : "Spike alerts off")} />
        </div>
        <div className="toggle-row">
          <div>
            <strong>Upstream server goes down</strong>
            <p className="muted small">Checked every 30 seconds.</p>
          </div>
          <Switch checked={s.alertOnUpstreamDown} label="Alert on upstream down" onChange={(v) => void save({ alertOnUpstreamDown: v }, v ? "Outage alerts on" : "Outage alerts off")} />
        </div>
        <div className="row actions-row">
          <SaveButton onSave={() => save({}, url.trim() === "" ? "Webhook removed — alerts are off" : "Alert settings saved")}>Save alerts</SaveButton>
          <SaveButton
            className="ghost"
            onSave={async () => {
              try {
                await api.testAlert();
                toast("success", "Test alert sent — check your channel");
                return true;
              } catch (err) {
                toast("error", errorText(err, "The test alert could not be sent."));
                return false;
              }
            }}
          >
            Send test alert
          </SaveButton>
        </div>
        <p className="muted small">For safety, alerts only go to public https addresses, so a webhook URL can't be aimed at internal services.</p>
      </Card>

      <Card title="Sessions" subtitle="Signed in on a computer you no longer trust? End every session for this account at once." icon={Icon.out}>
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm("Sign out on every device, including this one?")) return;
            await api.logoutAll().catch(() => undefined);
            onSignedOut();
          }}
        >
          Sign out everywhere
        </button>
      </Card>
    </>
  );
}
