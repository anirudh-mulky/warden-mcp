import type { Collection } from "mongodb";
import type { Policy, PolicyInput, TenantId } from "@warden/shared";
import { defaultPolicy } from "./engine.js";

/** Reads and writes one policy document per tenant. */
export class PolicyStore {
  constructor(private readonly policies: Collection<Policy>) {}

  /** The tenant's policy, or the default if none has been saved yet. */
  async get(tenantId: TenantId): Promise<Policy> {
    const found = await this.policies.findOne({ tenantId }, { projection: { _id: 0 } });
    return found ?? defaultPolicy(tenantId);
  }

  async put(tenantId: TenantId, input: PolicyInput): Promise<Policy> {
    const policy: Policy = { tenantId, ...input, updatedAt: new Date().toISOString() };
    // upsert: insert if missing, replace if present. A copy is passed so the
    // driver's added _id never leaks into the object we return.
    await this.policies.replaceOne({ tenantId }, { ...policy }, { upsert: true });
    return policy;
  }
}
