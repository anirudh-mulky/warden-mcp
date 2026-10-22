import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { env } from "../env.js";

/**
 * The one DynamoDB connection the whole gateway shares — always to
 * DynamoDB Local, the free copy of DynamoDB that runs in Docker.
 *
 * There is deliberately no "real AWS" mode. env.ts requires a local
 * endpoint and refuses amazonaws.com, and the credentials below are
 * obviously fake: DynamoDB Local ignores them, but the AWS SDK refuses to
 * send a request without some. Real AWS would reject them, so even a
 * misconfiguration cannot run up a bill.
 */
const baseClient = new DynamoDBClient({
  region: env.AWS_REGION,
  endpoint: env.DYNAMODB_ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
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
