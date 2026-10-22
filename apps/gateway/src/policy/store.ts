import type { Collection } from "mongodb";
import type { ApiKeyId, Policy, PolicyInput, TenantId } from "@warden/shared";
import { defaultPolicy } from "./engine.js";

/**
 * Policies in MongoDB: one tenant-wide default (apiKeyId: null) plus
 * optional per-key overrides. A key with an override uses ONLY its own
 * policy — overrides replace the default rather than merging with it, so
 * what a key may do is always readable in one place.
 */
export class PolicyStore {
  constructor(private readonly policies: Collection<Policy>) {}

  /** Older documents predate some fields; fill them in so every reader sees a whole Policy. */
  private normalise(doc: Partial<Policy> & Pick<Policy, "tenantId">): Policy {
    return { ...defaultPolicy(doc.tenantId), ...doc, apiKeyId: doc.apiKeyId ?? null };
  }

  /** The stored policy for exactly this scope, or null if none was ever saved. */
  async getExact(tenantId: TenantId, apiKeyId: ApiKeyId | null): Promise<Policy | null> {
    // { apiKeyId: null } also matches documents with no apiKeyId field at all (pre-override data).
    const doc = await this.policies.findOne({ tenantId, apiKeyId }, { projection: { _id: 0 } });
    return doc === null ? null : this.normalise(doc);
  }

  /** The policy that governs a call: the key's override if it has one, else the tenant default. */
  async get(tenantId: TenantId, apiKeyId?: ApiKeyId): Promise<Policy> {
    if (apiKeyId !== undefined) {
      const override = await this.getExact(tenantId, apiKeyId);
      if (override !== null) return override;
    }
    return (await this.getExact(tenantId, null)) ?? defaultPolicy(tenantId);
  }

  async put(tenantId: TenantId, apiKeyId: ApiKeyId | null, input: PolicyInput): Promise<Policy> {
    const policy: Policy = { tenantId, apiKeyId, ...input, updatedAt: new Date().toISOString() };
    // A copy, so the driver's added _id never leaks into the object we return.
    await this.policies.replaceOne({ tenantId, apiKeyId }, { ...policy }, { upsert: true });
    return policy;
  }

  /** Delete a key's override, so it falls back to the tenant default. */
  async removeOverride(tenantId: TenantId, apiKeyId: ApiKeyId): Promise<boolean> {
    const r = await this.policies.deleteOne({ tenantId, apiKeyId });
    return r.deletedCount === 1;
  }
}
