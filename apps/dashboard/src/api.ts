import type { ApiKey, CreatedApiKey, Me, Policy, PolicyInput, ToolCallRecord, ToolInfo, ToolStats } from "@warden/shared";

/**
 * Talks to the gateway's /api. The session lives in an httpOnly cookie that
 * the browser attaches by itself to same-origin requests, so this code never
 * sees or stores any credential — there is nothing here for an injected
 * script to steal.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...init.headers, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  signup: (email: string, password: string, signupCode: string) =>
    request<Me>("/api/auth/signup", json("POST", { email, password, signupCode: signupCode || undefined })),
  login: (email: string, password: string) => request<Me>("/api/auth/login", json("POST", { email, password })),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  me: () => request<Me>("/api/me"),

  calls: (since?: string, limit = 500) =>
    request<ToolCallRecord[]>(`/api/calls?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ""}`),
  health: () => fetch("/readyz").then((r) => r.json() as Promise<{ status: "ready" | "degraded" | "unavailable"; upstreams: { namespace: string; status: string }[] }>),
  stats: () => request<ToolStats[]>("/api/stats"),
  tools: () => request<ToolInfo[]>("/api/tools"),

  policy: () => request<Policy>("/api/policy"),
  savePolicy: (input: PolicyInput) => request<Policy>("/api/policy", json("PUT", input)),

  keys: () => request<ApiKey[]>("/api/keys"),
  createKey: (name: string) => request<CreatedApiKey>("/api/keys", json("POST", { name })),
  revokeKey: (id: string) => request<void>(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
