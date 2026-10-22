import type { ApiKeyId, TenantId } from "@warden/shared";
import { DynamoKeyStore } from "../auth/dynamo-store.js";
import { generateApiKey, newApiKeyId } from "../auth/keys.js";

/**
 * Admin CLI for API keys.
 *
 *   pnpm --filter @warden/gateway keys create <tenantId> <name...>
 *   pnpm --filter @warden/gateway keys list
 *   pnpm --filter @warden/gateway keys revoke <apiKeyId>
 *
 * The full key is printed exactly once, by `create`. Warden keeps only its
 * hash, so a lost key cannot be recovered — revoke it and create another.
 */

const TENANT_ID = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const store = new DynamoKeyStore();
const [command, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command === "create") {
  const [tenantId, ...nameParts] = rest;
  const name = nameParts.join(" ");
  if (tenantId === undefined || !TENANT_ID.test(tenantId) || name === "") {
    fail("usage: keys create <tenantId> <name>   (tenantId: lowercase letters, digits, - or _)");
  }

  const { key, prefix, hash } = generateApiKey();
  const id = newApiKeyId();
  await store.put({
    id,
    tenantId: tenantId as TenantId,
    name,
    prefix,
    hash,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });

  console.log(`created ${id} for tenant ${tenantId}`);
  console.log(`\n  ${key}\n`);
  console.log("This is the only time the key is shown. Store it somewhere safe.");
} else if (command === "list") {
  const keys = await store.list();
  if (keys.length === 0) console.log("no keys");
  for (const k of keys.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const status = k.revokedAt === null ? "active " : "REVOKED";
    console.log(`${status}  ${k.id}  ${k.prefix}…  tenant=${k.tenantId}  "${k.name}"  ${k.createdAt}`);
  }
} else if (command === "revoke") {
  const [id] = rest;
  if (id === undefined) fail("usage: keys revoke <apiKeyId>");
  const revoked = await store.revoke(id as ApiKeyId, new Date().toISOString());
  console.log(revoked ? `revoked ${id}` : `no active key with id ${id}`);
} else {
  fail("usage: keys <create|list|revoke> ...");
}
