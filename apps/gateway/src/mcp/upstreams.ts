/**
 * The upstream MCP servers this gateway fronts.
 *
 * Day 2: hardcoded, one server, so we can prove the plumbing works.
 * Day 3: this becomes a per-tenant registry read from MongoDB.
 *
 * Keeping it as a plain exported array today — with the same shape the
 * database rows will have — means Day 3 swaps the source without
 * touching a single line of the proxy code that consumes it.
 */
export interface UpstreamConfig {
  id: string;
  /** Prefix for this server's tools: "everything" -> "everything.echo". */
  namespace: string;
  /** How to launch it. Day 2 only supports stdio child processes. */
  command: string;
  args: string[];
}

export const UPSTREAMS: UpstreamConfig[] = [
  {
    id: "everything",
    namespace: "everything",
    // Resolved from apps/gateway/node_modules/.bin at runtime.
    command: "mcp-server-everything",
    args: ["stdio"],
  },
];
