import { useState } from "react";
import type { UpstreamView } from "@warden/shared";
import { api } from "../api";
import { useToast } from "../Toast";
import { Card, Empty, errorText, Icon, Pill, SaveButton, usePoll } from "../ui";

/** The MCP servers behind Warden: the shared built-ins, plus remote ones this tenant added. */
export function UpstreamsPage() {
  const toast = useToast();
  const [list, setList] = useState<UpstreamView[] | null>(null);
  const [namespace, setNamespace] = useState("");
  const [url, setUrl] = useState("");

  const load = () => api.upstreams().then(setList).catch(() => toast("error", "Could not load upstreams."));
  usePoll(load, 10_000);

  const builtin = (list ?? []).filter((u) => u.kind === "builtin");
  const custom = (list ?? []).filter((u) => u.kind === "custom");

  const status = (u: UpstreamView) => (
    <span className={`status-chip ${u.status}`} title={u.error ?? undefined}>
      <span className="status-dot" />
      {u.status === "connected" ? "Connected" : u.status === "failed" ? "Unreachable" : "Connecting…"}
    </span>
  );

  return (
    <>
      <Card title="Built-in servers" subtitle="Shared by every tenant. Their tools are governed by each tenant's policy." icon={Icon.server}>
        <div className="upstream-grid">
          {builtin.map((u) => (
            <div key={u.id} className="glass upstream">
              <div className="upstream-head">
                <span className="mono strong">{u.namespace}.*</span>
                {status(u)}
              </div>
              <p className="muted small">Local process over stdio{u.error ? ` · ${u.error}` : ""}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Your remote servers" subtitle="Add any MCP server reachable over Streamable HTTP. Only your keys can see its tools." icon={Icon.plug}>
        {custom.length === 0 ? (
          <Empty title="No remote servers yet">Add one below — its tools appear as <code>namespace.tool</code> for your agents.</Empty>
        ) : (
          <div className="upstream-grid">
            {custom.map((u) => (
              <div key={u.id} className="glass upstream">
                <div className="upstream-head">
                  <span className="mono strong">{u.namespace}.*</span>
                  {status(u)}
                </div>
                <p className="muted small mono wrap">{u.url}</p>
                <div className="row">
                  {u.toolCount !== null && <Pill tone="accent">{u.toolCount} tools</Pill>}
                  {u.error !== null && <span className="error small">{u.error}</span>}
                  <button
                    className="btn danger small push-right"
                    onClick={async () => {
                      if (!confirm(`Remove “${u.namespace}”? Its tools disappear for your agents immediately.`)) return;
                      await api.removeUpstream(u.id).catch(() => undefined);
                      toast("success", `${u.namespace} removed`);
                      void load();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="add-upstream">
          <label className="field">
            <span>Namespace</span>
            <input className="input" value={namespace} onChange={(e) => setNamespace(e.target.value.toLowerCase())} placeholder="github" />
          </label>
          <label className="field grow">
            <span>Server URL</span>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </label>
          <SaveButton
            onSave={async () => {
              try {
                await api.addUpstream(namespace.trim(), url.trim());
                toast("success", `${namespace} added — connecting…`);
                setNamespace("");
                setUrl("");
                void load();
                return true;
              } catch (err) {
                toast("error", errorText(err, "Could not add the server."));
                return false;
              }
            }}
          >
            Add server
          </SaveButton>
        </div>
        <p className="muted small">
          For safety, Warden only connects to <strong>public https</strong> addresses — never to localhost or private networks — so a URL can't be used to reach
          internal services. Remote servers are reached by URL only; Warden never runs commands you give it.
        </p>
      </Card>
    </>
  );
}
