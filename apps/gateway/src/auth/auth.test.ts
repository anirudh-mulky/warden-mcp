import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import type { ApiKeyId, TenantId } from "@warden/shared";
import { generateApiKey } from "./keys.js";
import { callerOf, requireApiKey } from "./middleware.js";
import { requireSession, startSession, userOf } from "./session.js";
import { InMemoryKeyStore } from "./store.js";

/**
 * The two "bouncers": requireApiKey (agents) and requireSession (humans),
 * exercised through real HTTP requests against a tiny app.
 */
const store = new InMemoryKeyStore();
const good = generateApiKey();
const revoked = generateApiKey();
let base = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  const now = new Date().toISOString();
  const tenantId = "t_acme" as TenantId;
  await store.put({ id: "key_good" as ApiKeyId, tenantId, name: "good", prefix: good.prefix, hash: good.hash, createdAt: now, revokedAt: null });
  await store.put({ id: "key_old" as ApiKeyId, tenantId, name: "old", prefix: revoked.prefix, hash: revoked.hash, createdAt: now, revokedAt: now });

  const app = express();
  app.get("/agent", requireApiKey(store), (_req, res) => {
    res.json(callerOf(res));
  });
  app.post("/login", async (_req, res) => {
    await startSession(res, { userId: "u1", email: "a@b.co", tenantId });
    res.end();
  });
  app.get("/human", requireSession(), (_req, res) => {
    res.json(userOf(res));
  });
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

describe("requireApiKey", () => {
  it("rejects a request with no key", async () => {
    assert.equal((await fetch(`${base}/agent`)).status, 401);
  });

  it("rejects malformed, unknown and revoked keys with the identical response", async () => {
    const bodies = await Promise.all(
      ["hello", generateApiKey().key, revoked.key].map(async (k) => {
        const r = await fetch(`${base}/agent`, bearer(k));
        assert.equal(r.status, 401);
        return r.text();
      }),
    );
    assert.equal(new Set(bodies).size, 1, "an attacker must not be able to tell these apart");
  });

  it("lets a valid key through and identifies the tenant", async () => {
    const r = await fetch(`${base}/agent`, bearer(good.key));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { tenantId: "t_acme", apiKeyId: "key_good" });
  });
});

describe("requireSession", () => {
  it("rejects a request with no cookie", async () => {
    assert.equal((await fetch(`${base}/human`)).status, 401);
  });

  it("sets an httpOnly, SameSite=Strict cookie that then opens the route", async () => {
    const login = await fetch(`${base}/login`, { method: "POST" });
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const r = await fetch(`${base}/human`, { headers: { cookie: cookie.split(";")[0]! } });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { tenantId: string }).tenantId, "t_acme");
  });

  it("rejects a tampered token", async () => {
    const login = await fetch(`${base}/login`, { method: "POST" });
    const [pair] = (login.headers.get("set-cookie") ?? "").split(";");
    const tampered = `${pair!.slice(0, -2)}xx`; // corrupt the signature
    assert.equal((await fetch(`${base}/human`, { headers: { cookie: tampered } })).status, 401);
  });
});
