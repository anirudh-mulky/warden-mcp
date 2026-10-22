import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { dynamo, TABLES } from "../db/dynamo.js";

/**
 * Creates Warden's tables in DynamoDB Local (env.ts guarantees the endpoint
 * is local — Warden never talks to real AWS).
 *
 * Idempotent: a table that already exists is left untouched, so running
 * this twice is harmless. The Docker setup runs it on every start.
 *
 * Run with: pnpm db:setup
 */

async function ensureTable(name: string, keyField: string): Promise<void> {
  try {
    await dynamo.send(new DescribeTableCommand({ TableName: name }));
    console.log(`exists:  ${name}`);
    return;
  } catch (err) {
    // "Not found" is the expected case on a first run. Anything else
    // (Docker not running, wrong port) is a real problem — let it crash.
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }

  await dynamo.send(
    new CreateTableCommand({
      TableName: name,
      // Only the key is declared up front. Other fields need no schema.
      AttributeDefinitions: [{ AttributeName: keyField, AttributeType: "S" }],
      // "HASH" is DynamoDB's word for partition key. Unrelated to SHA-256.
      KeySchema: [{ AttributeName: keyField, KeyType: "HASH" }],
      // DynamoDB Local requires a billing mode but charges nothing either way.
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  console.log(`created: ${name}`);
}

// API keys are looked up by the SHA-256 of the key, on every request.
await ensureTable(TABLES.apiKeys, "hash");
// Rate-limit counters are looked up by "<apiKeyId>#<minute>".
await ensureTable(TABLES.rateLimits, "pk");
