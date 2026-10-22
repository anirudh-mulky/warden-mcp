import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, TABLES } from "../db/dynamo.js";

export interface RateLimiter {
  /**
   * Count one event in `bucket` (e.g. "key:key_123" or "login-ip:1.2.3.4").
   * False means the limit for the current window is already used up.
   */
  take(bucket: string, limit: number, windowSeconds?: number): Promise<boolean>;
}

/**
 * Fixed-window rate limiter in DynamoDB: one counter per bucket per window.
 *
 * The counter lives in DynamoDB, not in this process's memory, so the
 * limit holds even with several gateway instances running at once.
 *
 * The whole check is ONE atomic UpdateItem: "add 1, but only if the count
 * is still below the limit". Reading the count and then writing it back as
 * two steps would let two simultaneous calls both read 59 and both pass a
 * limit of 60 — a race condition.
 *
 * Trade-off vs. a token bucket: simpler (one item, one write), but a burst
 * straddling a window boundary can briefly get up to 2x the limit.
 */
export class DynamoRateLimiter implements RateLimiter {
  async take(bucket: string, limit: number, windowSeconds = 60): Promise<boolean> {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: TABLES.rateLimits,
          Key: { pk: `${bucket}#${windowSeconds}#${window}` },
          UpdateExpression: "ADD #count :one SET expiresAt = :expiresAt",
          ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: { "#count": "count" },
          ExpressionAttributeValues: {
            ":one": 1,
            ":limit": limit,
            // Epoch seconds. With DynamoDB TTL enabled on this attribute,
            // old counters delete themselves instead of piling up forever.
            ":expiresAt": (window + 2) * windowSeconds,
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
