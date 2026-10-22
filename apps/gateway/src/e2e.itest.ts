import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Approval, AuditEntry, CreatedApiKey, Me, PolicyView, ToolCallRecord, ToolInfo, UpstreamView } from "@warden/shared";
import { DynamoKeyStore } from "./auth/dynamo-store.js";
import { hashApiKey } from "./auth/keys.js";
import { createWarden, type Warden } from "./bootstrap.js";
import { dynamo, TABLES } from "./db/dynamo.js";
import { mongoClient } from "./db/mongo.js";
import { SANDBOX } from "./mcp/upstreams.js";

/**
 * End-to-end: whole user journeys against REAL infrastructure — MongoDB,
 * DynamoDB Local, the real upstream MCP servers as child processes, and a
 * real remote MCP server over HTTP for the custom-upstream test.
 *
 * Needs Docker running locally (pnpm infra:up && pnpm db:setup). In CI, the
 * workflow starts the same two databases as service containers.
 * The npm script sets ALLOW_PRIVATE_NETWORK_TARGETS (the test's own webhook
 * and remote server live on localhost) and a 3s APPROVAL_TIMEOUT_MS.
 */

let warden: Warden;
let server: ReturnType<Warden["app"]["listen"]>;
let base = "";
const tenants: string[] = [];

before(async () => {
  warden = await createWarden({ watchUpstreams: false });
  server = warden.app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  // Leave both databases as we found them — Mongo AND the keys in DynamoDB.
  const db = mongoClient.db();
  for (const c of ["calls", "policies", "users", "approvals", "audit", "settings", "upstreams"]) {
    await db.collection(c).deleteMany({ tenantId: { $in: tenants } });
  }
  for (const key of await new DynamoKeyStore().list()) {
    if (tenants.includes(key.tenantId)) await dynamo.send(new DeleteCommand({ TableName: TABLES.apiKeys, Key: { hash: key.hash } }));
  }
  server.close();
  await warden.close();
});

/* ------------------------------------------------------------- helpers */

type Api = <T>(path: string, init?: RequestInit) => Promise<{ status: number; body: T; headers: Headers; text: string }>;

/** A browser-like client: remembers its session cookie. */
async function signUp() {
  const email = `e2e-${randomBytes(4).toString("hex")}@example.com`;
  const password = "a long enough password";
  const res = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 201);
  const me = (await res.json()) as Me;
  tenants.push(me.tenantId);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;

  const api: Api = async (path, init = {}) => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, cookie, "content-type": "application/json" } });
    const text = await r.text(); // some responses (204, a bare 404) have no body
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: r.status, body: body as never, headers: r.headers, text };
  };
  const newKey = async (name = "agent", expiresInDays: number | null = null) =>
    (await api<CreatedApiKey>("/api/keys", { method: "POST", body: JSON.stringify({ name, expiresInDays }) })).body;
  const setPolicy = (policy: Record<string, unknown>, key?: string) =>
    api<PolicyView>(`/api/policy${key ? `?key=${key}` : ""}`, { method: "PUT", body: JSON.stringify({ allow: [], deny: [], rateLimitPerMinute: null, ...policy }) });
  return { me, email, password, api, newKey, setPolicy };
}

async function agent(key: string) {
  const client = new Client({ name: "e2e-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
  };
  return { client, call };
}

const mcpStatus = async (key: string) =>
  (
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
  ).status;

async function calls(api: Api): Promise<ToolCallRecord[]> {
  await warden.recorder.flush();
  return (await api<ToolCallRecord[]>("/api/calls")).body;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* --------------------------------------------------------------- tests */

describe("a tenant's whole journey", () => {
  it("signs up, issues a key, is governed by policy, and sees every call", async () => {
    const { me, api, newKey, setPolicy } = await signUp();
    const created = await newKey("e2e agent");
    assert.match(created.key, /^wdn_/);
    assert.equal("hash" in created.apiKey, false, "the hash must never leave the backend");

    assert.equal((await setPolicy({ deny: ["fs.write_file"], rateLimitPerMinute: 3 })).status, 200);

    const { client, call } = await agent(created.key);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("everything.echo"));
    assert.ok(!names.includes("fs.write_file"), "denied tools are hidden from tools/list");

    const denied = await call("fs.write_file", { path: "x", content: "y" });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /blocked by policy/);

    for (let i = 1; i <= 3; i++) assert.equal((await call("everything.echo", { message: `hi ${i}` })).isError, false);
    const throttled = await call("everything.echo", { message: "one too many" });
    assert.match(throttled.text, /rate limit/);
    await client.close();

    const log = await calls(api);
    assert.deepEqual(log.map((c) => c.verdict).reverse(), ["deny", "allow", "allow", "allow", "throttle"]);
    assert.ok(log.every((c) => c.tenantId === me.tenantId));

    assert.equal((await api(`/api/keys/${created.apiKey.id}`, { method: "DELETE" })).status, 204);
    assert.equal(await mcpStatus(created.key), 401, "a revoked key is refused at once");
  });

  it("keeps tenants apart", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const key = await alice.newKey("alice");
    const { client, call } = await agent(key.key);
    await call("everything.echo", { message: "alice only" });
    await client.close();

    assert.equal((await calls(alice.api)).length, 1);
    assert.equal((await calls(bob.api)).length, 0, "bob must not see alice's calls");
    assert.equal((await bob.api(`/api/keys/${key.apiKey.id}`, { method: "DELETE" })).status, 404, "bob cannot revoke alice's key");
    assert.equal((await bob.api(`/api/policy?key=${key.apiKey.id}`)).status, 404, "bob cannot read alice's per-key policy");
  });

  it("refuses the dashboard API without a session", async () => {
    assert.equal((await fetch(`${base}/api/calls`)).status, 401);
  });
});

describe("argument rules", () => {
  it("blocks a write outside the allowed folder, even through ../", async () => {
    const { api, newKey, setPolicy } = await signUp();
    const key = await newKey();
    await setPolicy({ argRules: [{ tool: "fs.write_file", arg: "path", op: "pathOutside", value: join(SANDBOX, "public") }] });

    const { client, call } = await agent(key.key);
    const escape = await call("fs.write_file", { path: join(SANDBOX, "public") + "/../escaped.txt", content: "nope" });
    assert.equal(escape.isError, true);
    assert.match(escape.text, /is outside/);
    await client.close();

    const [last] = await calls(api);
    assert.equal(last?.verdict, "deny");
  });
});

describe("secret redaction", () => {
  it("masks secrets in tool results before the agent sees them, and counts them", async () => {
    const { api, newKey, setPolicy } = await signUp();
    const key = await newKey();
    const { client, call } = await agent(key.key);

    const before = await call("everything.echo", { message: "key AKIAIOSFODNN7EXAMPLE" });
    assert.match(before.text, /AKIAIOSFODNN7EXAMPLE/, "masking is off by default");

    await setPolicy({ redactSecrets: true });
    const after_ = await call("everything.echo", { message: "key AKIAIOSFODNN7EXAMPLE" });
    assert.ok(!after_.text.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.match(after_.text, /\[REDACTED:aws-key\]/);
    await client.close();

    const [last] = await calls(api);
    assert.equal(last?.redactions, 1);
  });
});

describe("approval mode", () => {
  it("holds a call until a human approves it, then lets it through", async () => {
    const { api, newKey, setPolicy } = await signUp();
    const key = await newKey();
    await setPolicy({ approval: ["everything.echo"] });
    const { client, call } = await agent(key.key);

    const pendingCall = call("everything.echo", { message: "approve me" });
    const pending = await waitFor(async () => (await api<{ pending: Approval[] }>("/api/approvals")).body.pending[0]);
    assert.equal(pending.tool, "everything.echo");
    assert.deepEqual(pending.args, { message: "approve me" }, "the reviewer sees what the call wants to do");

    assert.equal((await api(`/api/approvals/${pending.id}`, { method: "POST", body: JSON.stringify({ decision: "approved" }) })).status, 200);
    const result = await pendingCall;
    assert.equal(result.isError, false);
    assert.match(result.text, /approve me/);

    assert.equal((await api(`/api/approvals/${pending.id}`, { method: "POST", body: JSON.stringify({ decision: "denied" }) })).status, 409, "a decision cannot be changed");
    const decided = (await api<{ recent: Approval[] }>("/api/approvals")).body.recent[0];
    assert.equal(decided?.status, "approved");
    assert.equal(decided?.args, undefined, "arguments are deleted once decided");

    const [last] = await calls(api);
    assert.equal(last?.approval, "approved");
    await client.close();
  });

  it("refuses the call when the human denies it, or nobody answers in time", async () => {
    const { api, newKey, setPolicy } = await signUp();
    const key = await newKey();
    await setPolicy({ approval: ["everything.*"] });
    const { client, call } = await agent(key.key);

    const deniedCall = call("everything.echo", { message: "deny me" });
    const pending = await waitFor(async () => (await api<{ pending: Approval[] }>("/api/approvals")).body.pending[0]);
    await api(`/api/approvals/${pending.id}`, { method: "POST", body: JSON.stringify({ decision: "denied" }) });
    assert.match((await deniedCall).text, /denied by a reviewer/);

    const ignored = await call("everything.echo", { message: "nobody looks" }); // 3s timeout in tests
    assert.match(ignored.text, /timed out/);
    await client.close();

    const [last, previous] = await calls(api);
    assert.equal(last?.approval, "expired");
    assert.equal(previous?.approval, "denied");
  });
});

describe("per-key policies", () => {
  it("lets one key have stricter rules than the tenant default, and fall back when removed", async () => {
    const { api, newKey, setPolicy } = await signUp();
    const laptop = await newKey("laptop");
    const ci = await newKey("ci");

    const override = await setPolicy({ deny: ["everything.echo"] }, ci.apiKey.id);
    assert.equal(override.body.isOverride, true);

    const tools = (await api<ToolInfo[]>(`/api/tools?key=${ci.apiKey.id}`)).body;
    assert.equal(tools.find((t) => t.name === "everything.echo")?.verdict, "deny");

    const a = await agent(laptop.key);
    const b = await agent(ci.key);
    assert.equal((await a.call("everything.echo", { message: "laptop" })).isError, false, "the default still applies to other keys");
    assert.equal((await b.call("everything.echo", { message: "ci" })).isError, true, "the override applies to its key");

    assert.equal((await api(`/api/policy?key=${ci.apiKey.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await api<PolicyView>(`/api/policy?key=${ci.apiKey.id}`)).body.isOverride, false);
    assert.equal((await b.call("everything.echo", { message: "ci again" })).isError, false, "back on the default");
    await Promise.all([a.client.close(), b.client.close()]);
  });
});

describe("key expiry", () => {
  it("refuses a key once its expiry has passed", async () => {
    const { newKey } = await signUp();
    const key = await newKey("short-lived", 1);
    assert.ok(key.apiKey.expiresAt !== null);
    assert.equal(await mcpStatus(key.key), 200);

    // Fast-forward: move the expiry into the past directly in DynamoDB.
    await dynamo.send(
      new UpdateCommand({ TableName: TABLES.apiKeys, Key: { hash: hashApiKey(key.key) }, UpdateExpression: "SET expiresAt = :past", ExpressionAttributeValues: { ":past": new Date(Date.now() - 1000).toISOString() } }),
    );
    assert.equal(await mcpStatus(key.key), 401);
  });
});

describe("export and audit", () => {
  it("exports the call log as CSV and records who changed what", async () => {
    const { api, email, newKey, setPolicy } = await signUp();
    const key = await newKey("exporter");
    await setPolicy({ deny: ["fs.write_file"] });
    const { client, call } = await agent(key.key);
    await call("everything.echo", { message: "=HYPERLINK(\"http://evil\")" });
    await client.close();
    await warden.recorder.flush();

    const csv = await api("/api/calls/export?format=csv");
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-disposition") ?? "", /attachment; filename="warden-calls-.*\.csv"/);
    const [header, row] = csv.text.split("\n");
    assert.ok(header?.startsWith("startedAt,tool,verdict"));
    assert.match(row ?? "", /everything\.echo,allow/);

    const json = await api<ToolCallRecord[]>("/api/calls/export?format=json");
    assert.equal(json.body.length, 1);

    await new Promise((r) => setTimeout(r, 200)); // audit writes are fire-and-forget
    const audit = (await api<AuditEntry[]>("/api/audit")).body;
    const actions = audit.map((e) => e.action);
    for (const a of ["account.create", "key.create", "policy.update", "calls.export"]) assert.ok(actions.includes(a), `audit has ${a}`);
    const policyChange = audit.find((e) => e.action === "policy.update");
    assert.equal(policyChange?.actor, email);
    assert.match(policyChange?.detail ?? "", /\+block fs\.write_file/);
  });
});

describe("account security", () => {
  it("rate-limits password guessing per email address", async () => {
    const { email } = await signUp();
    const attempt = () => fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrong password!!" }) });
    for (let i = 0; i < 8; i++) assert.equal((await attempt()).status, 401);
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "600");
  });

  it("'sign out everywhere' ends the current session immediately", async () => {
    const { api } = await signUp();
    assert.equal((await api("/api/me")).status, 200);
    assert.equal((await api("/api/auth/logout-all", { method: "POST" })).status, 204);
    assert.equal((await api("/api/me")).status, 401, "the same cookie no longer works");
  });
});

describe("alerts", () => {
  let hook: Server;
  const received: unknown[] = [];
  before(async () => {
    hook = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end("ok");
      });
    }).listen(0);
  });
  after(() => hook.close());

  it("sends a test alert to the tenant's webhook", async () => {
    const { api } = await signUp();
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
    const saved = await api("/api/settings", { method: "PUT", body: JSON.stringify({ webhookUrl: url, alertOnBlockedSpike: true, blockedSpikeThreshold: 3, alertOnUpstreamDown: true }) });
    assert.equal(saved.status, 200);
    assert.equal((await api("/api/settings/test", { method: "POST" })).status, 204);
    assert.match(JSON.stringify(received.at(-1)), /test alert/);
  });

  it("alerts once when blocked calls spike", async () => {
    const { api, newKey, setPolicy } = await signUp();
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ webhookUrl: url, alertOnBlockedSpike: true, blockedSpikeThreshold: 3, alertOnUpstreamDown: false }) });
    await setPolicy({ deny: ["everything.echo"] });
    const key = await newKey();
    const { client, call } = await agent(key.key);
    const before_ = received.length;
    for (let i = 0; i < 5; i++) {
      await call("everything.echo", { message: `blocked ${i}` });
      await warden.recorder.flush();
    }
    await client.close();
    await waitFor(async () => (received.length > before_ ? true : undefined));
    await new Promise((r) => setTimeout(r, 300));
    const spikes = received.slice(before_).filter((b) => JSON.stringify(b).includes("blocked-spike"));
    assert.equal(spikes.length, 1, "a spike is one alert, not one per blocked call");
  });
});

describe("custom upstreams", () => {
  let remote: ChildProcess;
  let remoteUrl = "";
  before(async () => {
    const require = createRequire(import.meta.url);
    const entry = join(dirname(require.resolve("@modelcontextprotocol/server-everything/package.json")), "dist", "index.js");
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    remote = spawn(process.execPath, [entry, "streamableHttp"], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
    remoteUrl = `http://127.0.0.1:${port}/mcp`;
    await waitFor(async () => (await fetch(remoteUrl, { method: "GET" }).catch(() => null)) ?? undefined, 15_000);
  });
  after(() => remote.kill());

  it("adds a remote MCP server whose tools only that tenant can use", async () => {
    const owner = await signUp();
    const other = await signUp();
    assert.equal((await owner.api("/api/upstreams", { method: "POST", body: JSON.stringify({ namespace: "everything", url: remoteUrl }) })).status, 409, "built-in names are reserved");
    assert.equal((await owner.api("/api/upstreams", { method: "POST", body: JSON.stringify({ namespace: "remote", url: remoteUrl }) })).status, 201);

    const list = (await owner.api<UpstreamView[]>("/api/upstreams")).body;
    const mine = list.find((u) => u.namespace === "remote");
    assert.equal(mine?.status, "connected");
    assert.ok((mine?.toolCount ?? 0) > 0);

    const a = await agent((await owner.newKey()).key);
    assert.ok((await a.client.listTools()).tools.some((t) => t.name === "remote.echo"));
    const r = await a.call("remote.echo", { message: "via remote" });
    assert.equal(r.isError, false);
    assert.match(r.text, /via remote/);

    const b = await agent((await other.newKey()).key);
    assert.ok(!(await b.client.listTools()).tools.some((t) => t.name.startsWith("remote.")), "other tenants don't see it");
    assert.equal((await b.call("remote.echo", { message: "x" })).isError, true);
    await Promise.all([a.client.close(), b.client.close()]);
  });
});
