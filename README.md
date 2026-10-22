# Warden

A policy and observability gateway for [Model Context Protocol](https://modelcontextprotocol.io) servers.

AI agents are normally wired straight to several MCP servers — filesystem,
GitHub, a database — with nothing recording what they do and nothing able to
say no. Warden replaces that with **one endpoint and one API key**. Behind it,
Warden aggregates every upstream server's tools, enforces the key's policy on
each call, records every call, and shows them live.

```
  AI agent ──(Streamable HTTP + API key)──▶  Warden  ──(stdio)──▶ filesystem server
                                               │      ──(stdio)──▶ everything server
                         DynamoDB ◀────────────┤  API keys (SHA-256 hashed), rate-limit counters
                         MongoDB  ◀────────────┤  users, policies, call log
   Browser ──(session cookie)──▶ dashboard ────┘  keys, policy editor, stats, live calls
```

Self-hosted: the whole thing starts with one command in Docker, and costs
nothing to run — no cloud account is involved, by design.

## What it does

- **Proxies MCP.** Agents speak Streamable HTTP to Warden; Warden speaks stdio
  to long-lived upstream processes. Tools are namespaced (`fs.read_file`) so
  two upstreams can both have a `search`.
- **Two kinds of identity.** Agents use API keys (`wdn_` + 32 random bytes,
  stored only as a SHA-256 hash). Humans sign in to the dashboard with an
  email and password (scrypt-hashed) and get a signed JWT in an httpOnly,
  SameSite=Strict cookie. A leaked agent key cannot open the dashboard.
- **Enforces per-tenant policy.** Allow and deny lists with patterns (`*`,
  `fs.*`, exact names; deny always wins) and a per-key calls-per-minute limit
  held in DynamoDB with one atomic update. Denied tools are hidden from
  `tools/list` *and* refused on `tools/call`. Refusals come back as MCP
  `isError` results, so the agent can read why and adapt.
- **Records every call** — tenant, key, tool, verdict, reason, latency, and a
  hash of the arguments (never the arguments themselves) — to MongoDB,
  without making the agent wait for the write.
- **Self-service dashboard.** Sign up (optionally invite-only), create and
  revoke keys, edit the policy, see per-tool counts with p50/p95 latency, and
  watch calls arrive live.
- **Degrades instead of failing.** If one upstream won't start, the rest still
  serve; `/readyz` reports `degraded` (200) or `unavailable` (503).

## Run it (one command)

Needs Docker Desktop.

```bash
cp .env.example .env
# put a secret in .env:  JWT_SECRET=<output of: openssl rand -hex 32>
pnpm app            # or: docker compose --profile app up --build -d
```

Open **http://localhost:8080**, create an account, create an API key. Point an
MCP client (e.g. `npx @modelcontextprotocol/inspector`) at
`http://localhost:8080/mcp` with the header `Authorization: Bearer <key>`.
Add `everything.echo` to the deny list and watch the next call get refused in
the live feed. `pnpm app:down` stops everything; data survives in Docker volumes.

## Develop

Needs Node 22+ and pnpm as well.

```bash
pnpm install
cp apps/gateway/.env.example apps/gateway/.env
pnpm infra:up       # just MongoDB + DynamoDB Local
pnpm db:setup       # create the tables (idempotent)
pnpm dev            # gateway on :8080, reloads on save
pnpm dashboard      # dashboard on :5173, proxies /api to the gateway
```

Admin CLI: `pnpm keys create <tenant> <name>`, `pnpm keys list`, `pnpm keys revoke <id>`.
Benchmark: `pnpm bench`.

## Tests

```bash
pnpm test                 # 28 unit tests — no Docker needed
pnpm test:integration     # full journey against real Mongo, DynamoDB Local and upstreams
```

The integration test signs up, issues a key, sets a policy, then drives a real
MCP client through deny → allow → throttle, checks the call log, revokes the
key, and checks that one tenant can never see or touch another's data. CI
(`.github/workflows/ci.yml`, free on public repos) runs typecheck, both suites
and a Docker build on every push.

## Performance

Measured with `pnpm bench`, which times the same `everything.echo` call
directly against the upstream and through Warden (2,000 calls each, after
warm-up). Apple M3 Pro, Node 22, databases in local Docker, client and gateway
on the same machine — treat these as figures for this setup, not universal ones.

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Direct to upstream (baseline) | 0.06 ms | 0.11 ms | 0.16 ms |
| Through Warden | 3.28 ms | 5.18 ms | 6.54 ms |
| Through Warden, rate limiting on | 5.95 ms | 9.52 ms | 13.72 ms |
| Through Warden, 10 concurrent clients | 7.19 ms | 10.35 ms | 14.62 ms |

So Warden adds about **3 ms at p50 / 5 ms at p95** per call (key lookup,
policy check, call log), or about 6 / 9.5 ms with a rate limit, which costs one
conditional DynamoDB write per call. Throughput with 10 concurrent clients was
about **1,300 calls/s**. Re-run it on your machine with
`CALLS=2000 CONCURRENCY=10 pnpm bench`.

## Design decisions

| Decision | Why | Rejected |
|---|---|---|
| Low-level MCP `Server`, not `McpServer` | Warden owns no tools; its tool list is computed per request | fighting `McpServer`'s fixed-tool assumption |
| Stateless transport, long-lived upstream pool | no per-request session state, so any instance can serve any request; process startup stays off the hot path | spawning an upstream per call |
| SHA-256 for API keys | keys are 256 random bits, so unguessable; a slow hash would tax every call, and SHA-256 is deterministic so the hash is the DynamoDB key | argon2/scrypt for keys |
| scrypt for passwords | humans pick guessable passwords, so the hash must be slow and memory-hard; scrypt is built into Node, so nothing native to compile | argon2 (a native module) |
| DynamoDB + MongoDB | different access patterns: key/counter lookups on every call vs. document queries for the dashboard | one store for both |
| Policy fails closed, rate limit fails open | an outage must never mean "everything allowed"; a brief loss of limiting beats taking every tenant offline | the same rule for both |
| Fixed-window rate limit | one item and one atomic conditional write per call | token bucket (smoother, more state) |
| Live feed by polling | works the same with one gateway instance or many, since instances don't share memory | Server-Sent Events from process memory |
| No cloud, enforced in code | runs for $0 with zero billing risk; the config refuses any `amazonaws.com` endpoint and the DynamoDB client only ever holds fake local credentials | a cloud free tier (needs a card; a mistake can bill) |
| Gateway serves the dashboard | one container, one port, same-origin cookies, no CORS | a separate web server |

## Layout

```
apps/gateway/src
  index.ts          entry: listen + graceful shutdown
  bootstrap.ts      connect Mongo + DynamoDB + upstreams, build the app
  app.ts            routes; dependencies passed in, never imported
  auth/             API keys, the requireApiKey middleware, passwords, sessions
  policy/           pure decision engine, Mongo policy store, DynamoDB rate limiter
  telemetry/        call recorder: Mongo log, p50/p95 stats
  mcp/              upstream pool, MCP handlers (the policy seam), /mcp route
  api/              dashboard API: auth, keys, calls, stats, policy
  scripts/          create-tables, keys CLI
apps/dashboard      React 19 + Vite
packages/shared     types shared by gateway and dashboard (no runtime deps)
Dockerfile, docker-compose.yml
```

## Limits, honestly

- Self-hosted only: there is no public URL unless you put your own machine
  online.
- All tenants share the same upstream servers; policy decides what each may use.
- Key listing uses a DynamoDB Scan — fine at this scale, not at millions of keys.
- No login rate limiting yet; scrypt makes each guess expensive, but a
  per-IP limit on `/api/auth/login` would be the next step.
- The live feed polls every 2 seconds rather than pushing.

## Prior art

MCP gateways exist — [IBM ContextForge](https://github.com/IBM/mcp-context-forge),
[Microsoft mcp-gateway](https://github.com/microsoft/mcp-gateway), Envoy AI Gateway.
Those are platform products. Warden is a from-scratch implementation of the
narrow slice I wanted to understand deeply: per-key, tool-level policy with a
live audit trail.
