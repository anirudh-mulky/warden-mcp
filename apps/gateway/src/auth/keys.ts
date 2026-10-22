import { createHash, randomBytes } from "node:crypto";
import type { ApiKeyId } from "@warden/shared";

/**
 * API key material: generating keys, hashing them, and a cheap format check.
 *
 * Pure functions with no I/O, so they can be checked in isolation before
 * anything is built on top of them.
 *
 * Why SHA-256 and not argon2: argon2 is deliberately slow, which protects
 * guessable human passwords. These keys are 32 random bytes — there is
 * nothing to guess — so that slowness would only tax every tools/call.
 * SHA-256 is also deterministic, so the hash itself is the lookup key.
 */

/** Marks a string as a Warden key, for humans and for secret scanners. */
const KEY_PREFIX = "wdn_";

/** 32 bytes = 256 bits of randomness. */
const SECRET_BYTES = 32;

/** "wdn_" followed by 32 bytes in base64url: exactly 43 characters, no padding. */
const KEY_PATTERN = /^wdn_[A-Za-z0-9_-]{43}$/;

/** "wdn_" plus 4 secret characters: enough to tell keys apart. */
const DISPLAY_PREFIX_LENGTH = 8;

export interface NewApiKey {
  /** The full key. Shown to the user exactly once, then never stored. */
  key: string;
  /** Stored in plain text so a human can recognise the key later. */
  prefix: string;
  /** SHA-256 of the full key, hex. The only form of the key Warden keeps. */
  hash: string;
}

export function generateApiKey(): NewApiKey {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const key = `${KEY_PREFIX}${secret}`;
  return {
    key,
    prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
    hash: hashApiKey(key),
  };
}

/** A key's public identifier — safe to show and log, unlike the key itself. */
export function newApiKeyId(): ApiKeyId {
  return `key_${randomBytes(8).toString("hex")}` as ApiKeyId;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Rejects obvious garbage before it costs a database lookup. Passing this
 * proves nothing about validity — only that the string has the right shape.
 */
export function looksLikeApiKey(candidate: string): boolean {
  return KEY_PATTERN.test(candidate);
}
