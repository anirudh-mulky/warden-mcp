import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../env.js";

/**
 * SSRF guard for URLs that users give us (alert webhooks, custom upstreams).
 *
 * SSRF = server-side request forgery: tricking a server into making a
 * request on your behalf to somewhere only the server can reach — its own
 * admin ports, the database on the private network, or the cloud metadata
 * endpoint (169.254.169.254) that hands out credentials. Warden runs next
 * to MongoDB and DynamoDB; a webhook pointed at them must be refused.
 *
 * We resolve the hostname and check EVERY address it maps to, so a public-
 * looking name that resolves to 127.0.0.1 is caught too.
 *
 * Known limit: DNS can change between this check and the actual request
 * ("DNS rebinding"). Fully closing that means connecting to the checked IP
 * directly; it is noted rather than solved here.
 */

export class UnsafeUrlError extends Error {}

function ipv4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || // "this" network, private, loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast and reserved
  );
}

function ipv6Private(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return ipv4Private(v.slice(7)); // IPv4-mapped
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? ipv6Private(ip) : ipv4Private(ip);
}

/** Throws UnsafeUrlError unless `raw` is an http(s) URL that resolves only to public addresses. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("Only http(s) URLs are allowed.");
  if (url.username !== "" || url.password !== "") throw new UnsafeUrlError("URLs with embedded credentials are not allowed.");

  if (env.ALLOW_PRIVATE_NETWORK_TARGETS) return url;

  if (url.protocol !== "https:") throw new UnsafeUrlError("Use an https:// URL.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new UnsafeUrlError(`Could not resolve ${host}.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError(`${host} points at a private or internal address, which is not allowed.`);
  }
  return url;
}
