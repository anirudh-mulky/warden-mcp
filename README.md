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
- **Enforces policy per tenant — or per key.** Each tool is *allowed*,
  *blocked*, or *requires approval*; patterns (`*`, `fs.*`, exact names; deny
  always wins); a per-key calls-per-minute limit held in DynamoDB with one
  atomic update. Any key can get its own stricter policy. Denied tools are
  hidden from `tools/list` *and* refused on `tools/call`, as MCP `isError`
  results the agent can read and adapt to.
- **Argument rules.** Block a call by what it does, not just which tool it is —
  e.g. `fs.write_file` when `path` is outside `/app/sandbox/public`. Paths are
  normalised first, so `../` escapes and look-alike sibling folders are caught.
- **Human approval.** A matching call is held open while a person approves or
  denies it in the dashboard (with the arguments shown, secrets masked); no
  answer in 45 s means refused.
- **Secret masking.** API keys, tokens, private keys and `password=…` values
  (optionally emails) are scrubbed from tool *results* before the model sees them.
- **Records every call** — tenant, key, tool, verdict, reason, latency, masked
  count, approval outcome, and a hash of the arguments (never the arguments
  themselves) — to MongoDB, without making the agent wait for the write.
  Export as CSV or JSON.
- **Audit trail** of every change made through the dashboard, with policy diffs.
- **Alerts** to a Discord or Slack webhook on a spike in blocked calls (once
  per 10 minutes, not per call) or when an upstream goes down.
- **Bring your own servers.** Tenants add remote MCP servers by URL (Streamable
  HTTP only — never a command, which would be remote code execution).
- **Hardened accounts.** scrypt passwords, login rate limiting per email and
  per IP, optional invite-only sign-up, key expiry, and *sign out everywhere*
  that revokes every session instantly. Webhook and server URLs pass an SSRF
  guard: https only, and no address that resolves to a private network,
  localhost or cloud metadata.
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
pnpm test                 # 51 unit tests — no Docker needed
pnpm test:integration     # 15 end-to-end tests against real Mongo, DynamoDB Local and upstreams
```

Unit tests cover the policy engine (including `../` path traversal), secret
masking, the SSRF guard's address ranges, key format, scrypt, and both auth
middlewares (identical 401s for bad/revoked/expired keys, tampered and revoked
sessions). The integration tests drive real MCP clients through every feature:
deny → allow → throttle, argument rules, masking, approve/deny/timeout,
per-key overrides, key expiry, CSV/JSON export, the audit trail, login rate
limiting, sign-out-everywhere, webhook alerts, a remote custom upstream, and
tenant isolation throughout. CI (`.github/workflows/ci.yml`, free on public
repos) runs typecheck, both suites and a Docker build on every push.

## Performance

Measured with `pnpm bench`, which times the same `everything.echo` call
directly against the upstream and through Warden (2,000 calls each, after
warm-up). Apple M3 Pro, Node 22, databases in local Docker, client and gateway
on the same machine — treat these as figures for this setup, not universal ones.

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Direct to upstream (baseline) | 0.06 ms | 0.11 ms | 0.16 ms |
| Through Warden | 4.09 ms | 5.75 ms | 7.52 ms |
| Through Warden, rate limiting on | 6.27 ms | 10.10 ms | 15.19 ms |
| Through Warden, 10 concurrent clients | 6.74 ms | 9.18 ms | 14.19 ms |

So Warden adds about **4 ms at p50 / 5.6 ms at p95** per call (key lookup,
policy lookup — per-key override, then tenant default — decision, call log),
or about 6 / 10 ms with a rate limit, which costs one conditional DynamoDB
write per call. Throughput with 10 concurrent clients was about **1,400
calls/s**. Calls that wait for human approval are excluded from latency
stats, since that time is a person deciding. Re-run it on your machine with
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
| Normalise paths before argument rules | `startsWith("/sandbox/public")` passes `/sandbox/public/../secret` and `/sandbox/public-evil`; normalising and comparing whole segments doesn't | plain string prefix checks |
| Approvals stored in MongoDB, call held open | the decision reaches the waiting call even if it's on another instance; no queue or callback protocol needed | an in-memory promise per call |
| Mask secrets in results, not just logs | once a key is in the model's context it can be repeated anywhere; scrubbing at the gateway means the model never sees it | logging-only redaction |
| Custom upstreams by URL only | a user-supplied *command* would be remote code execution on the gateway host | letting tenants add stdio servers |
| SSRF guard on user URLs | webhooks and upstreams run next to the databases; every resolved address must be public, https only, no redirects | trusting the URL |
| sessionVersion in every token | a JWT can't be un-signed; one indexed lookup per dashboard request makes revocation and deleted accounts take effect instantly | waiting for tokens to expire |
| `trust proxy` off by default | trusting `X-Forwarded-For` from anyone lets a client fake its IP and dodge per-IP login limits | trusting every proxy header |
| `index.html` never cached, hashed assets cached forever | a cached index keeps loading last release's bundle | one cache lifetime for everything |

## Layout

```
apps/gateway/src
  index.ts          entry: listen + graceful shutdown
  bootstrap.ts      connect Mongo + DynamoDB + upstreams, build the app
  app.ts            routes; dependencies passed in, never imported
  auth/             API keys, the requireApiKey middleware, passwords, sessions
  policy/           pure decision engine (incl. argument rules), secret masking,
                    Mongo policy store (per-key overrides), DynamoDB rate limiter
  approvals/        human-in-the-loop approvals
  audit/            the audit trail
  alerts/           webhook alerts and their settings
  upstreams/        tenants' remote MCP servers
  net/              the SSRF guard
  telemetry/        call recorder: Mongo log, export, p50/p95 stats
  mcp/              upstream pool, MCP handlers (the policy seam), /mcp route
  api/              dashboard API
  scripts/          create-tables, keys CLI, bench
apps/dashboard      React 19 + Vite — glass UI, one file per page in pages/
packages/shared     types shared by gateway and dashboard (no runtime deps)
Dockerfile, docker-compose.yml
```

## Limits, honestly

- Self-hosted only: there is no public URL unless you put your own machine
  online.
- All tenants share the same upstream servers; policy decides what each may use.
- Key listing uses a DynamoDB Scan — fine at this scale, not at millions of keys.
- The SSRF guard checks DNS before connecting; a hostile DNS server could still
  change the answer between the check and the request ("DNS rebinding").
  Closing that fully means connecting to the checked IP directly.
- Secret masking recognises *shapes* (AKIA…, ghp_…, PEM blocks, `password=`);
  a secret with no distinctive format can slip through.
- An approval holds the agent's HTTP request open for up to 45 s; clients with
  a shorter timeout will give up first.
- The live feed polls every 2 seconds rather than pushing.

## Prior art

MCP gateways exist — [IBM ContextForge](https://github.com/IBM/mcp-context-forge),
[Microsoft mcp-gateway](https://github.com/microsoft/mcp-gateway), Envoy AI Gateway.
Those are platform products. Warden is a from-scratch implementation of the
narrow slice I wanted to understand deeply: per-key, tool-level policy with a
live audit trail.
