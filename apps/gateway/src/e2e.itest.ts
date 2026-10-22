import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CreatedApiKey, Me, ToolCallRecord } from "@warden/shared";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoKeyStore } from "./auth/dynamo-store.js";
import { createWarden, type Warden } from "./bootstrap.js";
import { dynamo, TABLES } from "./db/dynamo.js";
import { mongoClient } from "./db/mongo.js";

/**
 * End-to-end: the whole user journey against REAL infrastructure — MongoDB,
 * DynamoDB Local, and the real upstream MCP servers as child processes.
 *
 * Needs Docker running locally (pnpm infra:up && pnpm db:setup). In CI, the
 * workflow starts the same two databases as service containers.
 */

let warden: Warden;
let server: ReturnType<Warden["app"]["listen"]>;
let base = "";
const tenants: string[] = [];

before(async () => {
  warden = await createWarden();
  server = warden.app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  // Leave both databases as we found them — Mongo AND the keys in DynamoDB.
  const db = mongoClient.db();
  await db.collection("calls").deleteMany({ tenantId: { $in: tenants } });
  await db.collection("policies").deleteMany({ tenantId: { $in: tenants } });
  await db.collection("users").deleteMany({ tenantId: { $in: tenants } });
  for (const key of await new DynamoKeyStore().list()) {
    if (tenants.includes(key.tenantId)) {
      await dynamo.send(new DeleteCommand({ TableName: TABLES.apiKeys, Key: { hash: key.hash } }));
    }
  }
  server.close();
  await warden.close();
});

/** A browser-like client: remembers its session cookie. */
async function signUp() {
  const email = `e2e-${randomBytes(4).toString("hex")}@example.com`;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "a long enough password" }),
  });
  assert.equal(res.status, 201);
  const me = (await res.json()) as Me;
  tenants.push(me.tenantId);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;

  const api = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, cookie, "content-type": "application/json" } });
    const text = await r.text(); // some responses (204, a bare 404) have no body
    return { status: r.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
  };
  return { me, api };
}

async function agent(key: string) {
  const client = new Client({ name: "e2e-agent", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
  };
  return { client, call };
}

describe("a tenant's whole journey", () => {
  it("signs up, issues a key, is governed by policy, and sees every call", async () => {
    const { me, api } = await signUp();

    const created = await api<CreatedApiKey>("/api/keys", { method: "POST", body: JSON.stringify({ name: "e2e agent" }) });
    assert.equal(created.status, 201);
    assert.match(created.body.key, /^wdn_/);
    assert.equal("hash" in created.body.apiKey, false, "the hash must never leave the backend");

    const saved = await api("/api/policy", {
      method: "PUT",
      body: JSON.stringify({ allow: [], deny: ["fs.write_file"], rateLimitPerMinute: 3 }),
    });
    assert.equal(saved.status, 200);

    const { client, call } = await agent(created.body.key);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("everything.echo"));
    assert.ok(!names.includes("fs.write_file"), "denied tools are hidden from tools/list");

    const denied = await call("fs.write_file", { path: "x", content: "y" });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /blocked by policy/);

    for (let i = 1; i <= 3; i++) assert.equal((await call("everything.echo", { message: `hi ${i}` })).isError, false);
    const throttled = await call("everything.echo", { message: "one too many" });
    assert.equal(throttled.isError, true);
    assert.match(throttled.text, /rate limit/);
    await client.close();

    await warden.recorder.flush();
    const calls = await api<ToolCallRecord[]>("/api/calls");
    assert.deepEqual(
      calls.body.map((c) => c.verdict).reverse(),
      ["deny", "allow", "allow", "allow", "throttle"],
    );
    assert.ok(calls.body.every((c) => c.tenantId === me.tenantId));

    // Revoking the key locks the agent out immediately.
    const revoke = await api(`/api/keys/${created.body.apiKey.id}`, { method: "DELETE" });
    assert.equal(revoke.status, 204);
    const locked = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.body.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{}",
    });
    assert.equal(locked.status, 401);
  });

  it("keeps tenants apart", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const key = await alice.api<CreatedApiKey>("/api/keys", { method: "POST", body: JSON.stringify({ name: "alice" }) });

    const { client, call } = await agent(key.body.key);
    await call("everything.echo", { message: "alice only" });
    await client.close();
    await warden.recorder.flush();

    assert.equal((await alice.api<ToolCallRecord[]>("/api/calls")).body.length, 1);
    assert.equal((await bob.api<ToolCallRecord[]>("/api/calls")).body.length, 0, "bob must not see alice's calls");
    assert.equal((await bob.api(`/api/keys/${key.body.apiKey.id}`, { method: "DELETE" })).status, 404, "bob cannot revoke alice's key");
  });

  it("refuses the dashboard API without a session", async () => {
    assert.equal((await fetch(`${base}/api/calls`)).status, 401);
  });
});
