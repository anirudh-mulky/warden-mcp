import type {
  ApiKey,
  Approval,
  AuditEntry,
  CreatedApiKey,
  Me,
  PolicyInput,
  PolicyView,
  SettingsInput,
  TenantSettings,
  TenantUpstream,
  ToolCallRecord,
  ToolInfo,
  ToolStats,
  UpstreamView,
} from "@warden/shared";

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
  const res = await fetch(path, { ...init, headers: { ...init.headers, "Content-Type": "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const scope = (key: string | null) => (key === null ? "" : `?key=${encodeURIComponent(key)}`);

export const api = {
  signup: (email: string, password: string, signupCode: string) =>
    request<Me>("/api/auth/signup", json("POST", { email, password, signupCode: signupCode || undefined })),
  login: (email: string, password: string) => request<Me>("/api/auth/login", json("POST", { email, password })),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  logoutAll: () => request<void>("/api/auth/logout-all", { method: "POST" }),
  me: () => request<Me>("/api/me"),

  calls: (since?: string, limit = 500) => request<ToolCallRecord[]>(`/api/calls?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ""}`),
  exportUrl: (format: "csv" | "json", from?: string, to?: string) =>
    `/api/calls/export?format=${format}${from ? `&from=${encodeURIComponent(from)}` : ""}${to ? `&to=${encodeURIComponent(to)}` : ""}`,
  stats: () => request<ToolStats[]>("/api/stats"),
  health: () => fetch("/readyz").then((r) => r.json() as Promise<{ status: "ready" | "degraded" | "unavailable"; upstreams: { namespace: string; status: string }[] }>),

  tools: (key: string | null) => request<ToolInfo[]>(`/api/tools${scope(key)}`),
  policy: (key: string | null) => request<PolicyView>(`/api/policy${scope(key)}`),
  savePolicy: (key: string | null, input: PolicyInput) => request<PolicyView>(`/api/policy${scope(key)}`, json("PUT", input)),
  resetPolicy: (key: string) => request<void>(`/api/policy${scope(key)}`, { method: "DELETE" }),

  keys: () => request<ApiKey[]>("/api/keys"),
  createKey: (name: string, expiresInDays: number | null) => request<CreatedApiKey>("/api/keys", json("POST", { name, expiresInDays })),
  revokeKey: (id: string) => request<void>(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),

  approvals: () => request<{ pending: Approval[]; recent: Approval[] }>("/api/approvals"),
  approvalCount: () => request<{ pending: number }>("/api/approvals/count"),
  decide: (id: string, decision: "approved" | "denied") => request<Approval>(`/api/approvals/${encodeURIComponent(id)}`, json("POST", { decision })),

  audit: () => request<AuditEntry[]>("/api/audit"),

  settings: () => request<TenantSettings>("/api/settings"),
  saveSettings: (input: SettingsInput) => request<TenantSettings>("/api/settings", json("PUT", input)),
  testAlert: () => request<void>("/api/settings/test", { method: "POST" }),

  upstreams: () => request<UpstreamView[]>("/api/upstreams"),
  addUpstream: (namespace: string, url: string) => request<TenantUpstream>("/api/upstreams", json("POST", { namespace, url })),
  removeUpstream: (id: string) => request<void>(`/api/upstreams/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
