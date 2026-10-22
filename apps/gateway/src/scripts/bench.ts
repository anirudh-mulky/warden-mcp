import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { cpus, platform, release } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { ApiKeyId, TenantId } from "@warden/shared";
import { DynamoKeyStore } from "../auth/dynamo-store.js";
import { generateApiKey } from "../auth/keys.js";
import { createWarden } from "../bootstrap.js";
import { dynamo, TABLES } from "../db/dynamo.js";
import { mongoClient } from "../db/mongo.js";
import { PolicyStore } from "../policy/store.js";
import { UPSTREAMS } from "../mcp/upstreams.js";
import { percentile } from "../telemetry/recorder.js";

/**
 * How much latency does Warden add to a tool call?
 *
 * Times the same `everything.echo` call three ways, on this machine:
 *   1. direct   — an MCP client talking straight to the upstream over stdio
 *   2. warden   — through Warden: HTTP, API key check, policy, call log
 *   3. warden + rate limit — as 2, plus one DynamoDB write per call
 * and then a concurrent run to get throughput.
 *
 * Needs the databases running (pnpm infra:up && pnpm db:setup).
 * Run: pnpm bench   (optionally CALLS=1000 CONCURRENCY=20 pnpm bench)
 *
 * The numbers are for THIS machine with local Docker databases — quote them
 * with that context, never as universal figures.
 */

const CALLS = Number(process.env.CALLS ?? 500);
const WARMUP = 50;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);

interface Summary {
  p50: number;
  p95: number;
  p99: number;
}

function summarise(ms: number[]): Summary {
  const sorted = [...ms].sort((a, b) => a - b);
  const r = (p: number) => Math.round((percentile(sorted, p) ?? 0) * 100) / 100;
  return { p50: r(50), p95: r(95), p99: r(99) };
}

async function timeCalls(client: Client, n: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const result = (await client.callTool({ name: "everything.echo", arguments: { message: `bench ${i}` } })) as { isError?: boolean };
    times.push(performance.now() - start);
    if (result.isError === true) throw new Error("benchmark call was refused — is a policy in the way?");
  }
  return times;
}

// --------------------------------------------------------------- setup

const tenantId = `bench_${randomBytes(4).toString("hex")}` as TenantId;
const { key, prefix, hash } = generateApiKey();
const keyStore = new DynamoKeyStore();
await keyStore.put({ id: "key_bench" as ApiKeyId, tenantId, name: "benchmark", prefix, hash, createdAt: new Date().toISOString(), revokedAt: null, expiresAt: null });
const openPolicy = { allow: [], deny: [], rateLimitPerMinute: null, argRules: [], approval: [], redactSecrets: false, redactEmails: false };

const warden = await createWarden();
const server = warden.app.listen(0);
const url = new URL(`http://localhost:${(server.address() as AddressInfo).port}/mcp`);
const policies = new PolicyStore(mongoClient.db().collection("policies"));

async function wardenClient(): Promise<Client> {
  const client = new Client({ name: "bench", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

// The upstream on its own, for the baseline. The direct client sees the
// upstream's own tool name ("echo"), so wrap it to share timeCalls().
const everything = UPSTREAMS.find((u) => u.namespace === "everything")!;
const direct = new Client({ name: "bench-direct", version: "0" });
await direct.connect(new StdioClientTransport({ command: everything.command, args: everything.args, stderr: "ignore" }));
const directAsNamespaced = {
  callTool: (req: { name: string; arguments: Record<string, unknown> }) => direct.callTool({ ...req, name: "echo" }),
} as unknown as Client;

try {
  // ------------------------------------------------------------- runs
  console.log(`warming up (${WARMUP} calls each)…`);
  await timeCalls(directAsNamespaced, WARMUP);
  const client = await wardenClient();
  await timeCalls(client, WARMUP);

  console.log(`timing ${CALLS} sequential calls each…`);
  const base = summarise(await timeCalls(directAsNamespaced, CALLS));
  const viaWarden = summarise(await timeCalls(client, CALLS));

  await policies.put(tenantId, null, { ...openPolicy, rateLimitPerMinute: 1_000_000 });
  await timeCalls(client, WARMUP);
  const withLimit = summarise(await timeCalls(client, CALLS));
  await policies.put(tenantId, null, openPolicy);

  console.log(`timing ${CALLS} calls across ${CONCURRENCY} concurrent clients…`);
  const workers = await Promise.all(Array.from({ length: CONCURRENCY }, () => wardenClient()));
  const perWorker = Math.ceil(CALLS / CONCURRENCY);
  const started = performance.now();
  const concurrentTimes = (await Promise.all(workers.map((w) => timeCalls(w, perWorker)))).flat();
  const seconds = (performance.now() - started) / 1000;
  const concurrent = summarise(concurrentTimes);

  // ----------------------------------------------------------- report
  const overhead = (s: Summary) => ({ p50: +(s.p50 - base.p50).toFixed(2), p95: +(s.p95 - base.p95).toFixed(2) });
  console.log(`\nmachine: ${cpus()[0]?.model ?? "unknown CPU"} · ${cpus().length} cores · ${platform()} ${release()} · node ${process.version}`);
  console.log("databases: local Docker (MongoDB, DynamoDB Local) · client and gateway on the same machine\n");
  console.table({
    "direct to upstream (baseline)": base,
    "through Warden": viaWarden,
    "through Warden + rate limit": withLimit,
    [`through Warden, ${CONCURRENCY} concurrent`]: concurrent,
  });
  console.log("added by Warden (vs baseline, ms):", overhead(viaWarden));
  console.log("added by Warden with rate limiting (ms):", overhead(withLimit));
  console.log(`throughput: ${Math.round(concurrentTimes.length / seconds)} calls/s with ${CONCURRENCY} concurrent clients (${concurrentTimes.length} calls in ${seconds.toFixed(1)}s)`);

  await Promise.all([client.close(), ...workers.map((w) => w.close())]);
} finally {
  // ---------------------------------------------------------- cleanup
  await direct.close();
  await warden.recorder.flush();
  const db = mongoClient.db();
  await db.collection("calls").deleteMany({ tenantId });
  await db.collection("policies").deleteMany({ tenantId });
  await dynamo.send(new DeleteCommand({ TableName: TABLES.apiKeys, Key: { hash } }));
  server.close();
  await warden.close();
}
