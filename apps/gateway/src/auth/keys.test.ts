import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateApiKey, hashApiKey, looksLikeApiKey, newApiKeyId } from "./keys.js";

describe("API keys", () => {
  it("generates wdn_ + 43 chars, with an 8-char prefix and a 64-char hex hash", () => {
    const { key, prefix, hash } = generateApiKey();
    assert.match(key, /^wdn_[A-Za-z0-9_-]{43}$/);
    assert.equal(prefix, key.slice(0, 8));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("never generates the same key twice", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    assert.equal(keys.size, 1000);
  });

  it("hashes deterministically, so the hash can be a lookup key", () => {
    const { key, hash } = generateApiKey();
    assert.equal(hashApiKey(key), hash);
  });

  it("rejects malformed keys before any lookup", () => {
    const { key } = generateApiKey();
    assert.equal(looksLikeApiKey(key), true);
    assert.equal(looksLikeApiKey("hello"), false);
    assert.equal(looksLikeApiKey(key.slice(0, -1)), false);
    assert.equal(looksLikeApiKey(`${key}x`), false);
  });

  it("makes public ids that are not the key", () => {
    assert.match(newApiKeyId(), /^key_[0-9a-f]{16}$/);
  });
});
