import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ApiKeyId, TenantId } from "@warden/shared";
import { dynamo, TABLES } from "../db/dynamo.js";
import type { KeyAdmin, StoredApiKey } from "./store.js";

/**
 * KeyStore backed by DynamoDB. The table's partition key is `hash`, so the
 * hot-path lookup (findByHash, on every request) is a single GetItem.
 *
 * "hash" is a DynamoDB reserved word, so expressions refer to it through the
 * placeholder "#h" instead of writing it directly.
 */
export class DynamoKeyStore implements KeyAdmin {
  private readonly table = TABLES.apiKeys;

  async findByHash(hash: string): Promise<StoredApiKey | null> {
    const result = await dynamo.send(new GetCommand({ TableName: this.table, Key: { hash } }));
    return (result.Item as StoredApiKey | undefined) ?? null;
  }

  async put(key: StoredApiKey): Promise<void> {
    try {
      await dynamo.send(
        new PutCommand({
          TableName: this.table,
          Item: key,
          // Atomic duplicate check: write only if no item has this hash yet.
          ConditionExpression: "attribute_not_exists(#h)",
          ExpressionAttributeNames: { "#h": "hash" },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new Error(`A key with this hash already exists (prefix ${key.prefix})`);
      }
      throw err;
    }
  }

  /**
   * Every key. Uses Scan, which reads the whole table — fine for an admin
   * command run by hand, never acceptable on the request path.
   */
  async list(): Promise<StoredApiKey[]> {
    const keys: StoredApiKey[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await dynamo.send(new ScanCommand({ TableName: this.table, ExclusiveStartKey: cursor }));
      keys.push(...((page.Items ?? []) as StoredApiKey[]));
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
    return keys;
  }

  /** One tenant's keys (Scan + filter: fine at this scale, see list()). */
  async listByTenant(tenantId: TenantId): Promise<StoredApiKey[]> {
    return (await this.list()).filter((k) => k.tenantId === tenantId);
  }

  /**
   * Marks a key revoked. Returns false if no such key, it was already
   * revoked, or — when tenantId is given — it belongs to another tenant.
   * That last check is what stops one dashboard user revoking another's keys.
   */
  async revoke(id: ApiKeyId, at: string, tenantId?: TenantId): Promise<boolean> {
    // The table is keyed by hash, not id, so find the hash first (admin-only Scan).
    const key = (await this.list()).find((k) => k.id === id);
    if (key === undefined || key.revokedAt !== null) return false;
    if (tenantId !== undefined && key.tenantId !== tenantId) return false;

    await dynamo.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { hash: key.hash },
        UpdateExpression: "SET revokedAt = :at",
        ExpressionAttributeValues: { ":at": at },
      }),
    );
    return true;
  }
}
