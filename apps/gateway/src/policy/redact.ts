/**
 * Masks secrets in tool RESULTS before they reach the agent.
 *
 * Why results: an agent that reads a file containing an AWS key now has
 * that key in its context, can repeat it, and may send it elsewhere.
 * Masking at the gateway means the model never sees it at all.
 *
 * These are recognisable shapes, not a guarantee: a secret with no
 * distinctive format (a random password in plain prose) can slip through.
 */

interface Pattern {
  label: string;
  re: RegExp;
  /** For "key = value" patterns, only the value (group 2) is masked. */
  valueGroup?: boolean;
}

const SECRET_PATTERNS: Pattern[] = [
  { label: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { label: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { label: "stripe-key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { label: "warden-key", re: /\bwdn_[A-Za-z0-9_-]{43}\b/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    label: "secret",
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)(\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    valueGroup: true,
  },
];

const EMAIL: Pattern = { label: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g };

export interface RedactOptions {
  secrets: boolean;
  emails: boolean;
}

/** Returns the masked text and how many things were masked. */
export function redactText(text: string, opts: RedactOptions): { text: string; count: number } {
  const patterns = [...(opts.secrets ? SECRET_PATTERNS : []), ...(opts.emails ? [EMAIL] : [])];
  let count = 0;
  let out = text;
  for (const p of patterns) {
    out = out.replace(p.re, (...m: string[]) => {
      count += 1;
      // "password = hunter22" keeps "password = " and masks only the value.
      return p.valueGroup === true ? `${m[1]}${m[2]}[REDACTED:${p.label}]` : `[REDACTED:${p.label}]`;
    });
  }
  return { text: out, count };
}

/** Masks every string inside any JSON-like value, however deeply nested. */
export function redactValue(value: unknown, opts: RedactOptions): { value: unknown; count: number } {
  if (typeof value === "string") {
    const r = redactText(value, opts);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((v) => {
      const r = redactValue(v, opts);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  if (value !== null && typeof value === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactValue(v, opts);
      count += r.count;
      out[k] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

/**
 * Masks the parts of an MCP tool result an agent reads: text content items
 * and structuredContent. Images and other binary content pass untouched.
 */
export function redactToolResult<T>(result: T, opts: RedactOptions): { result: T; count: number } {
  if (!opts.secrets && !opts.emails) return { result, count: 0 };
  const r = result as { content?: unknown[]; structuredContent?: unknown };
  let count = 0;
  const next: Record<string, unknown> = { ...(result as Record<string, unknown>) };

  if (Array.isArray(r.content)) {
    next.content = r.content.map((item) => {
      const c = item as { type?: string; text?: unknown };
      if (c.type !== "text" || typeof c.text !== "string") return item;
      const masked = redactText(c.text, opts);
      count += masked.count;
      return { ...c, text: masked.text };
    });
  }
  if (r.structuredContent !== undefined) {
    const masked = redactValue(r.structuredContent, opts);
    count += masked.count;
    next.structuredContent = masked.value;
  }
  return { result: next as T, count };
}
