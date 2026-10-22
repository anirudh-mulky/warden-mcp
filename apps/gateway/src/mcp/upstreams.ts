import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";

/**
 * The upstream MCP servers this gateway fronts. Every tenant shares them;
 * each tenant's policy decides which of their tools it may use.
 */
export interface UpstreamConfig {
  id: string;
  /** Prefix for this server's tools: "fs" -> "fs.read_file". */
  namespace: string;
  /** How to launch it as a stdio child process. */
  command: string;
  args: string[];
}

/**
 * Where a server's entry file lives inside node_modules.
 *
 * We launch it with process.execPath — the exact Node binary running
 * Warden — rather than relying on a command name being on PATH, which is
 * only true when run through pnpm.
 */
function entry(pkg: "server-everything" | "server-filesystem"): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve(`@modelcontextprotocol/${pkg}/package.json`)), "dist", "index.js");
}

/** The only directory the fs upstream may touch. */
export const SANDBOX = env.FS_SANDBOX_DIR ?? fileURLToPath(new URL("../../../../sandbox", import.meta.url));

export const UPSTREAMS: UpstreamConfig[] = [
  {
    id: "everything",
    namespace: "everything",
    command: process.execPath,
    args: [entry("server-everything"), "stdio"],
  },
  {
    id: "filesystem",
    namespace: "fs",
    command: process.execPath,
    // The server refuses to read or write outside the directories it is
    // given. That is its own sandboxing, entirely separate from Warden's
    // policy engine — defence in depth, not redundancy.
    args: [entry("server-filesystem"), SANDBOX],
  },
];
