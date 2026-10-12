import { fileURLToPath } from "node:url";

/**
 * The upstream MCP servers this gateway fronts.
 *
 * Day 3: two of them, still hardcoded.
 * Day 4: this becomes a per-tenant registry read from MongoDB.
 *
 * The shape already matches the database rows it will become, so Day 4
 * swaps the source without touching the proxy code that consumes it.
 */
export interface UpstreamConfig {
  id: string;
  /** Prefix for this server's tools: "fs" -> "fs.read_file". */
  namespace: string;
  /** How to launch it. Day 3 only supports stdio child processes. */
  command: string;
  args: string[];
}

/** The repo's sandbox/ directory — the only place the fs upstream may touch. */
const SANDBOX = fileURLToPath(new URL("../../../../sandbox", import.meta.url));

export const UPSTREAMS: UpstreamConfig[] = [
  {
    id: "everything",
    namespace: "everything",
    command: "mcp-server-everything",
    args: ["stdio"],
  },
  {
    id: "filesystem",
    namespace: "fs",
    command: "mcp-server-filesystem",
    // The server refuses to read or write outside the directories it is
    // given. That is its own sandboxing, entirely separate from Warden's
    // policy engine — defence in depth, not redundancy.
    args: [SANDBOX],
  },
];
