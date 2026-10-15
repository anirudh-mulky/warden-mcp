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
                         MongoDB  ◀────────────┤  policies, call log
                         Dashboard ◀── SSE ────┘  live feed, per-tool stats, policy editor
```

## What it does

- **Proxies MCP.** Agents speak Streamable HTTP to Warden; Warden speaks stdio
  to long-lived upstream processes. Tools are namespaced (`fs.read_file`) so
  two upstreams can both have a `search`.
- **Authenticates every request.** API keys are `wdn_` + 32 random bytes,
  stored only as a SHA-256 hash. Missing, unknown and revoked keys all get the
  same 401; the real reason goes to the server log.
- **Enforces per-tenant policy.** Allow and deny lists with patterns (`*`,
  `fs.*`, exact names; deny always wins) and a per-key calls-per-minute limit
  held in DynamoDB with one atomic update. Denied tools are hidden from
  `tools/list` *and* refused on `tools/call`. Refusals come back as MCP
  `isError` results, so the agent can read why and adapt.
- **Records every call** — tenant, key, tool, verdict, reason, latency, and a
  hash of the arguments (never the arguments themselves) — to MongoDB, off the
  request path.
- **Shows it live.** A React dashboard streams calls over Server-Sent Events,
  shows per-tool counts with p50/p95 latency, and edits the policy.
- **Degrades instead of failing.** If one upstream won't start, the rest still
  serve; `/readyz` reports `degraded` (200) or `unavailable` (503).

## Design decisions

| Decision | Why | Rejected |
|---|---|---|
| Low-level MCP `Server`, not `McpServer` | Warden owns no tools; its tool list is computed per request | fighting `McpServer`'s fixed-tool assumption |
| Stateless transport, long-lived upstream pool | no per-request session state, so any instance can serve any request; process startup stays off the hot path | spawning an upstream per call |
| SHA-256 for API keys, not argon2 | keys are 256 random bits, so unguessable; argon2's deliberate slowness would tax every call, and SHA-256 is deterministic so the hash is the DynamoDB key | argon2 (right for human passwords, not random keys) |
| DynamoDB + MongoDB | different access patterns: key/counter lookups on every call vs. document queries for the dashboard | one store for both |
| Policy fails closed, rate limit fails open | an outage must never mean "everything allowed"; a brief loss of limiting is better than taking every tenant offline | the same rule for both |
| Fixed-window rate limit | one item and one atomic write per call | token bucket (smoother, but more state per key) |
| Store an argument hash, not arguments | arguments may hold secrets; the hash still identifies repeats | storing raw arguments |

## Running it locally

Needs Node 22+, pnpm, and Docker Desktop. Everything runs on your machine — no
cloud account involved.

```bash
pnpm install
cp apps/gateway/.env.example apps/gateway/.env
pnpm infra:up                         # MongoDB + DynamoDB Local in Docker
pnpm db:setup                         # create the DynamoDB tables (idempotent)
pnpm keys create acme "my laptop"     # prints a new API key, once
pnpm dev                              # gateway on http://localhost:8080
pnpm dashboard                        # dashboard on http://localhost:5173
```

Connect an MCP client (e.g. `npx @modelcontextprotocol/inspector`) to
`http://localhost:8080/mcp` with the header `Authorization: Bearer <key>`.
Open the dashboard with the same key, add `everything.echo` to the deny list,
and watch the next call get refused live.

Key admin: `pnpm keys list`, `pnpm keys revoke <apiKeyId>`.

## Layout

```
apps/gateway/src
  index.ts          connect to Mongo + upstreams, then listen; graceful shutdown
  app.ts            routes; dependencies passed in, never imported
  auth/             key generation, hashing, stores, the requireApiKey middleware
  policy/           pure decision engine, Mongo policy store, DynamoDB rate limiter
  telemetry/        call recorder: Mongo log, live-feed events, p50/p95 stats
  mcp/              upstream pool, MCP handlers (the policy seam), /mcp route
  api/              dashboard API: calls, stats, live stream, policy
  scripts/          create-tables, keys CLI
apps/dashboard      React 19 + Vite
packages/shared     types shared by gateway and dashboard (no runtime deps)
```

## Prior art

MCP gateways exist — [IBM ContextForge](https://github.com/IBM/mcp-context-forge),
[Microsoft mcp-gateway](https://github.com/microsoft/mcp-gateway), Envoy AI Gateway.
Those are platform products. Warden is a from-scratch implementation of the
narrow slice I wanted to understand deeply: per-key, tool-level policy with a
live audit trail.

## Not done (yet)

Cloud deployment (Terraform, Lambda), CI, dashboard login, per-tenant upstream
registration, argument redaction, and an automated test suite. The live feed is
in-process, so it only covers calls served by the same instance.
