# Warden

A policy and observability gateway for [Model Context Protocol](https://modelcontextprotocol.io) servers.

AI agents are configured with one Warden endpoint instead of a list of MCP
servers. Warden aggregates the tools of every upstream server registered to
an API key, enforces per-key policy on each `tools/call` — allowlists, rate
limits, argument redaction — and records every call as a searchable trace.

**Status:** day 1 of 14. Skeleton only.

## Prior art

MCP gateways exist — [IBM ContextForge](https://github.com/IBM/mcp-context-forge),
[Microsoft mcp-gateway](https://github.com/microsoft/mcp-gateway), Envoy AI Gateway.
Those are Kubernetes-scale platform products. Warden is a from-scratch
implementation of the narrow slice I found most interesting: per-API-key,
tool-level policy enforcement plus a live audit trail, deployed serverless on
always-free AWS tiers.


## Layout

```
apps/gateway      Express + TypeScript backend (the proxy and control API)
packages/shared   Domain types imported by both the gateway and the dashboard
```

## Running locally

```bash
pnpm install
cp apps/gateway/.env.example apps/gateway/.env
pnpm infra:up          # mongo + dynamodb-local in Docker
pnpm dev               # gateway on http://localhost:8080
curl localhost:8080/healthz
```
