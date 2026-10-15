import type { Policy, PolicyInput, ToolCallRecord, ToolStats } from "@warden/shared";

/**
 * Talks to the gateway's /api, always with the API key as a Bearer token.
 * The key never goes in a URL: URLs end up in logs and browser history.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText);
  return (await res.json()) as T;
}

export const api = {
  me: (key: string) => request<{ tenantId: string; apiKeyId: string }>(key, "/api/me"),
  calls: (key: string) => request<ToolCallRecord[]>(key, "/api/calls?limit=200"),
  stats: (key: string) => request<ToolStats[]>(key, "/api/stats"),
  policy: (key: string) => request<Policy>(key, "/api/policy"),
  savePolicy: (key: string, input: PolicyInput) =>
    request<Policy>(key, "/api/policy", { method: "PUT", body: JSON.stringify(input) }),
};

/**
 * Subscribe to the live feed. The browser's EventSource cannot send an
 * Authorization header, so we read the Server-Sent Events stream through
 * fetch instead and split it on the blank lines that separate events.
 * Returns a function that closes the stream.
 */
export function streamCalls(key: string, onCall: (call: ToolCallRecord) => void, onError: () => void): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch("/api/calls/stream", {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) throw new Error(`stream failed: ${res.status}`);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? ""; // the last piece may be incomplete
        for (const event of events) {
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice("data: ".length))
            .join("\n");
          if (data !== "") onCall(JSON.parse(data) as ToolCallRecord);
        }
      }
      if (!controller.signal.aborted) onError(); // server ended the stream
    } catch {
      if (!controller.signal.aborted) onError();
    }
  })();

  return () => controller.abort();
}
