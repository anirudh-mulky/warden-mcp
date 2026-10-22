import { useCallback, useEffect, useState } from "react";
import type { ApiKey, ArgOp, ArgRule, Policy, PolicyInput, ToolInfo } from "@warden/shared";
import { api } from "../api";
import { useToast } from "../Toast";
import { Card, Empty, errorText, Icon, Pill, SaveButton, Switch, Tile } from "../ui";

type Mode = "allow" | "approval" | "deny";

const OPS: { op: ArgOp; label: string }[] = [
  { op: "pathOutside", label: "is a path outside" },
  { op: "notStartsWith", label: "does not start with" },
  { op: "startsWith", label: "starts with" },
  { op: "contains", label: "contains" },
  { op: "equals", label: "equals" },
];
const opLabel = (op: ArgOp) => OPS.find((o) => o.op === op)?.label ?? op;

function linesToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function toInput(p: Policy): PolicyInput {
  const { allow, deny, rateLimitPerMinute, argRules, approval, redactSecrets, redactEmails } = p;
  return { allow, deny, rateLimitPerMinute, argRules, approval, redactSecrets, redactEmails };
}

export function PolicyPage() {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [scope, setScope] = useState<string | null>(null); // null = tenant default
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [isOverride, setIsOverride] = useState(false);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [limit, setLimit] = useState("");
  const [allowText, setAllowText] = useState("");
  const [denyText, setDenyText] = useState("");
  const [approvalText, setApprovalText] = useState("");
  const [rule, setRule] = useState<ArgRule>({ tool: "fs.write_file", arg: "path", op: "pathOutside", value: "" });

  useEffect(() => {
    api.keys().then((k) => setKeys(k.filter((x) => x.revokedAt === null))).catch(() => undefined);
  }, []);

  const reload = useCallback(
    async (previous?: ToolInfo[]) => {
      const [view, t] = await Promise.all([api.policy(scope), api.tools(scope)]);
      setPolicy(view.policy);
      setIsOverride(view.isOverride);
      setTools(t);
      setLimit(view.policy.rateLimitPerMinute === null ? "" : String(view.policy.rateLimitPerMinute));
      setAllowText(view.policy.allow.join("\n"));
      setDenyText(view.policy.deny.join("\n"));
      setApprovalText(view.policy.approval.join("\n"));
      if (previous === undefined) return 0;
      const before = new Map(previous.map((x) => [x.name, x.verdict]));
      const changed = new Set(t.filter((x) => before.get(x.name) !== x.verdict).map((x) => x.name));
      setFlash(changed);
      setTimeout(() => setFlash(new Set()), 1600);
      return changed.size;
    },
    [scope],
  );

  useEffect(() => {
    setPolicy(null);
    reload().catch(() => toast("error", "Could not load the policy."));
  }, [reload, toast]);

  if (policy === null) return <p className="muted">Loading…</p>;

  const save = async (patch: Partial<PolicyInput>, message: (changed: number) => string): Promise<boolean> => {
    try {
      await api.savePolicy(scope, { ...toInput(policy), ...patch });
      const changed = await reload(tools);
      toast("success", message(changed));
      return true;
    } catch (err) {
      toast("error", errorText(err, "Save failed."));
      return false;
    }
  };

  const setMode = async (tool: ToolInfo, mode: Mode) => {
    setBusyTool(tool.name);
    const deny = policy.deny.filter((d) => d !== tool.name);
    const approval = policy.approval.filter((d) => d !== tool.name);
    if (mode === "deny") deny.push(tool.name);
    if (mode === "approval") approval.push(tool.name);
    const words: Record<Mode, string> = { allow: "allowed", approval: "now needs your approval", deny: "now blocked" };
    await save({ deny, approval }, () => `${tool.name} ${words[mode]}`);
    setBusyTool(null);
  };

  const keyLabel = scope === null ? "every key" : (keys.find((k) => k.id === scope)?.name ?? "this key");
  const blocked = tools.filter((t) => t.verdict === "deny").length;
  const needsApproval = tools.filter((t) => t.verdict === "approval").length;
  const byNamespace = new Map<string, ToolInfo[]>();
  for (const t of tools) byNamespace.set(t.name.split(".")[0] ?? "", [...(byNamespace.get(t.name.split(".")[0] ?? "") ?? []), t]);
  const limitDirty = limit.trim() !== (policy.rateLimitPerMinute === null ? "" : String(policy.rateLimitPerMinute));
  const patternsDirty = allowText !== policy.allow.join("\n") || denyText !== policy.deny.join("\n") || approvalText !== policy.approval.join("\n");

  return (
    <>
      <div className="glass scope-bar">
        <div className="scope-left">
          <span className="muted small-label">Editing</span>
          <select className="input select" value={scope ?? ""} onChange={(e) => setScope(e.target.value === "" ? null : e.target.value)} aria-label="Policy scope">
            <option value="">Default policy — all keys</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                Key: {k.name}
              </option>
            ))}
          </select>
          {scope !== null && (isOverride ? <Pill tone="accent">Custom policy for this key</Pill> : <Pill>Inherits the default</Pill>)}
        </div>
        {scope !== null && isOverride && (
          <button
            className="btn ghost small"
            onClick={async () => {
              await api.resetPolicy(scope);
              await reload(tools);
              toast("success", `${keyLabel} now uses the default policy`);
            }}
          >
            Remove custom policy
          </button>
        )}
        {scope !== null && !isOverride && <span className="muted small">Any change below creates a custom policy for {keyLabel}.</span>}
      </div>

      <div className="tiles four">
        <Tile label="Tools available" value={tools.length - blocked} hint={`of ${tools.length}`} tone="allow" icon={Icon.check} />
        <Tile label="Need approval" value={needsApproval} tone="accent" icon={Icon.hand} />
        <Tile label="Blocked" value={blocked} tone="deny" icon={Icon.ban} />
        <Tile label="Rate limit" value={policy.rateLimitPerMinute === null ? "None" : `${policy.rateLimitPerMinute}/min`} hint="per API key" tone="throttle" icon={Icon.gauge} />
      </div>

      <div className="split">
        <Card title="Tools" subtitle={`What ${keyLabel} may do with each of ${tools.length} tools. Changes apply to the next call.`} icon={Icon.shield}>
          {tools.length === 0 ? (
            <Empty title="No tools" />
          ) : (
            [...byNamespace.entries()].map(([ns, list]) => (
              <div key={ns} className="tool-group">
                <h3 className="mono">{ns}</h3>
                <ul className="tool-list">
                  {list.map((t) => {
                    const mode: Mode = policy.deny.includes(t.name) ? "deny" : policy.approval.includes(t.name) ? "approval" : "allow";
                    // Blocked by a pattern or the allowlist rather than its own control: the control can't undo that.
                    const locked = t.verdict === "deny" && !policy.deny.includes(t.name);
                    return (
                      <li key={t.name} className={`tool v-${t.verdict} ${flash.has(t.name) ? "flash" : ""}`}>
                        <div className="tool-text">
                          <span className="mono tool-name">{t.name}</span>
                          <span className="muted tool-desc" title={locked ? (t.reason ?? "") : t.description}>
                            {locked ? t.reason : t.description}
                          </span>
                        </div>
                        <div className={`segmented ${locked ? "locked" : ""}`} role="radiogroup" aria-label={`Policy for ${t.name}`} title={locked ? "Blocked by an advanced rule" : undefined}>
                          {(["allow", "approval", "deny"] as Mode[]).map((m) => (
                            <button
                              key={m}
                              role="radio"
                              aria-checked={!locked && mode === m}
                              className={`seg seg-${m} ${!locked && mode === m ? "on" : ""}`}
                              disabled={locked || busyTool === t.name}
                              onClick={() => mode !== m && void setMode(t, m)}
                            >
                              {m === "allow" ? "Allow" : m === "approval" ? "Approve" : "Block"}
                            </button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </Card>

        <div className="stack">
          <Card title="Rate limit" subtitle="Maximum tool calls per minute, per API key." icon={Icon.gauge}>
            <div className="row">
              <input className="input narrow" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" aria-label="Calls per minute" />
              <span className="muted">calls / min</span>
            </div>
            <div className="row actions-row">
              <SaveButton
                onSave={async () => {
                  const v = limit.trim();
                  if (v !== "" && !/^[1-9]\d*$/.test(v)) {
                    toast("error", "The limit must be a whole number above 0, or blank for unlimited.");
                    return false;
                  }
                  return save({ rateLimitPerMinute: v === "" ? null : Number(v) }, () => (v === "" ? "Rate limit removed" : `Limit set to ${v} calls per minute per key`));
                }}
              >
                Save limit
              </SaveButton>
              {limitDirty && <span className="unsaved">Unsaved change</span>}
            </div>
          </Card>

          <Card title="Secret masking" subtitle="Scrub credentials from tool results before the agent ever sees them." icon={Icon.mask}>
            <div className="toggle-row">
              <div>
                <strong>Mask secrets</strong>
                <p className="muted small">API keys, tokens, private keys, password=… values</p>
              </div>
              <Switch checked={policy.redactSecrets} label="Mask secrets" onChange={(v) => void save({ redactSecrets: v }, () => (v ? "Secrets will be masked in tool results" : "Secret masking off"))} />
            </div>
            <div className="toggle-row">
              <div>
                <strong>Mask email addresses</strong>
                <p className="muted small">Replace any email in results with [REDACTED]</p>
              </div>
              <Switch checked={policy.redactEmails} label="Mask emails" onChange={(v) => void save({ redactEmails: v }, () => (v ? "Emails will be masked" : "Email masking off"))} />
            </div>
          </Card>
        </div>
      </div>

      <Card title="Argument rules" subtitle="Block a call by what it is trying to do, not just which tool it is. Paths are normalised, so ../ tricks don't work." icon={Icon.ban}>
        {policy.argRules.length === 0 ? (
          <p className="muted">No argument rules yet. Example: block <code>fs.write_file</code> when <code>path</code> is outside <code>/app/sandbox/public</code>.</p>
        ) : (
          <ul className="rules">
            {policy.argRules.map((r, i) => (
              <li key={`${r.tool}-${r.arg}-${i}`} className="glass rule">
                <span>
                  Block <code>{r.tool}</code> when <code>{r.arg}</code> {opLabel(r.op)} <code>{r.value}</code>
                </span>
                <button className="btn ghost small" onClick={() => void save({ argRules: policy.argRules.filter((_, j) => j !== i) }, () => "Rule removed")}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="rule-builder">
          <span className="muted">Block</span>
          <input className="input" list="tool-names" value={rule.tool} onChange={(e) => setRule({ ...rule, tool: e.target.value })} aria-label="Tool" placeholder="tool or fs.*" />
          <datalist id="tool-names">
            {tools.map((t) => (
              <option key={t.name} value={t.name} />
            ))}
          </datalist>
          <span className="muted">when</span>
          <input className="input" value={rule.arg} onChange={(e) => setRule({ ...rule, arg: e.target.value })} aria-label="Argument name" placeholder="argument" />
          <select className="input select" value={rule.op} onChange={(e) => setRule({ ...rule, op: e.target.value as ArgOp })} aria-label="Condition">
            {OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          <input className="input" value={rule.value} onChange={(e) => setRule({ ...rule, value: e.target.value })} aria-label="Value" placeholder={rule.op === "pathOutside" ? "/app/sandbox/public" : "value"} />
          <SaveButton
            onSave={async () => {
              if (rule.tool.trim() === "" || rule.arg.trim() === "" || rule.value.trim() === "") {
                toast("error", "Fill in the tool, the argument and the value.");
                return false;
              }
              const ok = await save({ argRules: [...policy.argRules, { ...rule, tool: rule.tool.trim(), arg: rule.arg.trim(), value: rule.value.trim() }] }, () => "Argument rule added");
              if (ok) setRule({ ...rule, value: "" });
              return ok;
            }}
          >
            Add rule
          </SaveButton>
        </div>
      </Card>

      <Card title="Advanced patterns" subtitle={<>Use <code>*</code> for every tool, <code>fs.*</code> for a whole server, or an exact name. Deny always wins.</>} icon={Icon.list}>
        <div className="grid three">
          <label className="field">
            <span>Allow only these (empty = allow everything)</span>
            <textarea value={allowText} onChange={(e) => setAllowText(e.target.value)} placeholder={"everything.*\nfs.read_text_file"} />
          </label>
          <label className="field">
            <span>Require approval</span>
            <textarea value={approvalText} onChange={(e) => setApprovalText(e.target.value)} placeholder="fs.write_file" />
          </label>
          <label className="field">
            <span>Always block</span>
            <textarea value={denyText} onChange={(e) => setDenyText(e.target.value)} placeholder="fs.move_file" />
          </label>
        </div>
        <div className="row actions-row">
          <SaveButton
            onSave={() =>
              save({ allow: linesToList(allowText), deny: linesToList(denyText), approval: linesToList(approvalText) }, (n) =>
                n === 0 ? "Patterns saved — no tool changed status" : `Patterns saved — ${n} tool${n === 1 ? "" : "s"} changed status`,
              )
            }
          >
            Save patterns
          </SaveButton>
          {patternsDirty && <span className="unsaved">Unsaved changes</span>}
        </div>
        <div className="active-rules">
          <span className="muted small-label">Active now</span>
          {policy.allow.length + policy.deny.length + policy.approval.length + policy.argRules.length === 0 && !policy.redactSecrets && policy.rateLimitPerMinute === null ? (
            <span className="muted">No rules — every tool is allowed.</span>
          ) : (
            <div className="rule-chips">
              {policy.allow.map((p) => (
                <span key={`a-${p}`} className="rule-chip allow">allow only {p}</span>
              ))}
              {policy.approval.map((p) => (
                <span key={`p-${p}`} className="rule-chip approval">approve {p}</span>
              ))}
              {policy.deny.map((p) => (
                <span key={`d-${p}`} className="rule-chip deny">block {p}</span>
              ))}
              {policy.argRules.map((r, i) => (
                <span key={`r-${i}`} className="rule-chip deny">
                  {r.tool}: {r.arg} {opLabel(r.op)} {r.value}
                </span>
              ))}
              {policy.rateLimitPerMinute !== null && <span className="rule-chip throttle">{policy.rateLimitPerMinute}/min</span>}
              {policy.redactSecrets && <span className="rule-chip accent">mask secrets</span>}
              {policy.redactEmails && <span className="rule-chip accent">mask emails</span>}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
