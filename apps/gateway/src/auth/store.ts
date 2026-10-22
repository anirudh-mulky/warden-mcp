import type { ApiKey, ApiKeyId, TenantId } from "@warden/shared";

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

/** Strips the hash: the only way a stored key may leave the backend. */
export function toPublicKey({ hash: _hash, ...publicFields }: StoredApiKey): ApiKey {
  return publicFields;
}

/**
 * Anything that can save and find API keys — all the auth middleware needs.
 * It depends on this interface, never on a concrete store, so tests hand
 * it the in-memory version and production hands it DynamoDB.
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

/** The extra operations the dashboard's key management needs. */
export interface KeyAdmin extends KeyStore {
  listByTenant(tenantId: TenantId): Promise<StoredApiKey[]>;
  /** False if missing, already revoked, or owned by a different tenant. */
  revoke(id: ApiKeyId, at: string, tenantId?: TenantId): Promise<boolean>;
}

/**
 * A key store held in a Map. Everything is lost when the process exits.
 * Used by the tests: fast, no Docker, and it behaves like the real store —
 * copies in and out, duplicate hashes rejected.
 */
export class InMemoryKeyStore implements KeyAdmin {
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

  async listByTenant(tenantId: TenantId): Promise<StoredApiKey[]> {
    return [...this.byHash.values()].filter((k) => k.tenantId === tenantId).map((k) => structuredClone(k));
  }

  async revoke(id: ApiKeyId, at: string, tenantId?: TenantId): Promise<boolean> {
    const key = [...this.byHash.values()].find((k) => k.id === id);
    if (key === undefined || key.revokedAt !== null) return false;
    if (tenantId !== undefined && key.tenantId !== tenantId) return false;
    key.revokedAt = at;
    return true;
  }
}
