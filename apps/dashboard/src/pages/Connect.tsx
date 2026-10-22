import { Card, CopyButton, Icon } from "../ui";

/** Where agents connect. In local dev the dashboard (5173) and gateway (8080) are separate servers. */
export const MCP_URL = location.port === "5173" ? "http://localhost:8080/mcp" : `${location.origin}/mcp`;

export function ConnectPage() {
  const config = JSON.stringify({ mcpServers: { warden: { url: MCP_URL, headers: { Authorization: "Bearer wdn_YOUR_KEY_HERE" } } } }, null, 2);

  return (
    <div className="split even">
      <div className="stack">
        <Card title="Endpoint" subtitle="Agents connect over Streamable HTTP, with an API key in the Authorization header." icon={Icon.plug}>
          <div className="secret big">
            <code className="mono">{MCP_URL}</code>
            <CopyButton text={MCP_URL} />
          </div>
        </Card>
        <Card title="Try it with the MCP Inspector" icon={Icon.bolt}>
          <ol className="steps">
            <li>
              Run <code>npx @modelcontextprotocol/inspector@latest</code>
            </li>
            <li>
              Add a server: transport <strong>Streamable HTTP</strong>, URL <code>{MCP_URL}</code>
            </li>
            <li>
              Add the header <code>Authorization</code> with the value <code>Bearer wdn_…</code>
            </li>
            <li>Connect, open Tools, and run any tool — it appears on the Overview within 2 seconds.</li>
          </ol>
        </Card>
      </div>
      <Card title="Client configuration" subtitle="Most MCP clients that support remote servers accept a block like this. Replace the key with one from API keys." icon={Icon.list}>
        <div className="code-block">
          <pre className="mono">{config}</pre>
          <CopyButton text={config} />
        </div>
      </Card>
    </div>
  );
}
