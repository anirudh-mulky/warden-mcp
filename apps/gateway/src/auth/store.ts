import type { ApiKey } from "@warden/shared";

/**
 * An API key as the backend stores it: the public shape plus its hash.
 *
 * Lives here, not in @warden/shared, on purpose. The shared ApiKey is what
 * may reach a browser; this type never leaves the gateway.
 */
export interface StoredApiKey extends ApiKey {
  /** SHA-256 of the full key, hex. Unique per key, and the lookup key. */
  hash: string;
}

/**
 * Anything that can save and find API keys.
 *
 * The middleware depends on this interface, never on a concrete store.
 * Today it gets the in-memory version; STEP 6 hands it a DynamoDB one,
 * and the middleware does not change.
 */
export interface KeyStore {
  /**
   * The key with this hash, or null if there is none.
   *
   * Revoked keys ARE returned. Deciding what a revoked key means is the
   * auth layer's job, not the store's — and the auth layer wants to know,
   * because a revoked key being tried is worth logging as a warning.
   */
  findByHash(hash: string): Promise<StoredApiKey | null>;

  /** Save a new key. Throws if a key with the same hash already exists. */
  put(key: StoredApiKey): Promise<void>;
}

/**
 * A KeyStore held in a Map. Everything is lost when the process exits.
 *
 * Good enough to build and check the middleware without Docker, and it
 * stays useful afterwards as the fake store for Day 12's tests.
 */
export class InMemoryKeyStore implements KeyStore {
  private readonly byHash = new Map<string, StoredApiKey>();

  async findByHash(hash: string): Promise<StoredApiKey | null> {
    const found = this.byHash.get(hash);
    return found === undefined ? null : structuredClone(found);
  }

  async put(key: StoredApiKey): Promise<void> {
    if (this.byHash.has(key.hash)) {
      throw new Error(`A key with this hash already exists (prefix ${key.prefix})`);
    }
    this.byHash.set(key.hash, structuredClone(key));
  }
}
