import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { env } from "../env.js";

/**
 * The one DynamoDB connection the whole gateway shares.
 *
 * Two modes, switched by DYNAMODB_ENDPOINT:
 *  - set (development): talk to DynamoDB Local in Docker on this machine.
 *    It ignores credentials, but the SDK refuses to send a request without
 *    any, so we hand it obviously fake ones.
 *  - unset (production, Day 9): talk to real AWS. No credentials appear in
 *    code; the SDK picks up the Lambda's own short-lived role automatically.
 *
 * env.ts guarantees the endpoint IS set in development, so this file can
 * never reach real AWS from a laptop by accident.
 */
const isLocal = env.DYNAMODB_ENDPOINT !== undefined;

const baseClient = new DynamoDBClient({
  region: env.AWS_REGION,
  ...(isLocal
    ? {
        endpoint: env.DYNAMODB_ENDPOINT,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : {}),
});

/**
 * The document client converts plain JS objects to DynamoDB's typed wire
 * format and back: { hash: "abc" } <-> { hash: { S: "abc" } }.
 */
export const dynamo = DynamoDBDocumentClient.from(baseClient);

/** Table names, from env, in one place. */
export const TABLES = {
  apiKeys: env.DYNAMODB_TABLE_API_KEYS,
  rateLimits: env.DYNAMODB_TABLE_RATE_LIMITS,
} as const;
