import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { dynamo, TABLES } from "../db/dynamo.js";
import { env } from "../env.js";

/**
 * Creates Warden's DynamoDB tables in DynamoDB Local. Development only.
 *
 * On AWS the tables are created by Terraform (Day 8), never by the app or
 * this script — so this refuses to run unless pointed at a local endpoint.
 *
 * Idempotent: a table that already exists is left untouched, so running
 * this twice is harmless.
 *
 * Run with: pnpm --filter @warden/gateway db:setup
 */

if (env.DYNAMODB_ENDPOINT === undefined) {
  console.error("Refusing to run: DYNAMODB_ENDPOINT is not set, so this would create tables in real AWS.");
  process.exit(1);
}

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
      // Irrelevant locally. Day 8 picks the real billing mode, after we
      // have checked exactly what the always-free tier covers.
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  console.log(`created: ${name}`);
}

// API keys are looked up by the SHA-256 of the key, on every request.
await ensureTable(TABLES.apiKeys, "hash");
// Rate-limit counters are looked up by "<apiKeyId>#<minute>".
await ensureTable(TABLES.rateLimits, "pk");
