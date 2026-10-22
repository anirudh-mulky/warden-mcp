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
const expired = generateApiKey();
let base = "";
let server: ReturnType<express.Express["listen"]>;

/** A stand-in for the users collection: one user whose sessionVersion the tests can bump. */
const fakeUser = { id: "u1", sessionVersion: 0 };
const fakeUsers = {
  findOne: async (filter: { id: string }) => (filter.id === fakeUser.id ? { ...fakeUser } : null),
} as unknown as Parameters<typeof requireSession>[0];

before(async () => {
  const now = new Date().toISOString();
  const tenantId = "t_acme" as TenantId;
  const base_ = { tenantId, createdAt: now, expiresAt: null };
  await store.put({ ...base_, id: "key_good" as ApiKeyId, name: "good", prefix: good.prefix, hash: good.hash, revokedAt: null });
  await store.put({ ...base_, id: "key_old" as ApiKeyId, name: "old", prefix: revoked.prefix, hash: revoked.hash, revokedAt: now });
  await store.put({ ...base_, id: "key_exp" as ApiKeyId, name: "exp", prefix: expired.prefix, hash: expired.hash, revokedAt: null, expiresAt: new Date(Date.now() - 1000).toISOString() });

  const app = express();
  app.get("/agent", requireApiKey(store), (_req, res) => {
    res.json(callerOf(res));
  });
  app.post("/login", async (_req, res) => {
    await startSession(res, { userId: "u1", email: "a@b.co", tenantId }, fakeUser.sessionVersion);
    res.end();
  });
  app.get("/human", requireSession(fakeUsers), (_req, res) => {
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
      ["hello", generateApiKey().key, revoked.key, expired.key].map(async (k) => {
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

  it("kills existing sessions when the user's session version is bumped (sign out everywhere)", async () => {
    const login = await fetch(`${base}/login`, { method: "POST" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal((await fetch(`${base}/human`, { headers: { cookie } })).status, 200);

    fakeUser.sessionVersion += 1; // what POST /api/auth/logout-all does
    assert.equal((await fetch(`${base}/human`, { headers: { cookie } })).status, 401, "the old token must stop working at once");
  });
});
