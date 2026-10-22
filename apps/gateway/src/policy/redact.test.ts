import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactText, redactToolResult } from "./redact.js";

const on = { secrets: true, emails: false };

describe("redactText", () => {
  it("masks common credential shapes", () => {
    const text = [
      "aws AKIAIOSFODNN7EXAMPLE",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
      "stripe sk_live_0123456789abcdefghij",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl",
    ].join("\n");
    const r = redactText(text, on);
    assert.equal(r.count, 4);
    assert.ok(!r.text.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.match(r.text, /\[REDACTED:aws-key\]/);
  });

  it("masks only the value of key = value secrets", () => {
    const r = redactText('password = "hunter2hunter2"', on);
    assert.equal(r.text, 'password = "[REDACTED:secret]"');
  });

  it("masks a whole private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    assert.equal(redactText(`key:\n${pem}\nend`, on).text, "key:\n[REDACTED:private-key]\nend");
  });

  it("leaves ordinary text alone", () => {
    const r = redactText("The sum of 2 and 3 is 5.", on);
    assert.equal(r.count, 0);
    assert.equal(r.text, "The sum of 2 and 3 is 5.");
  });

  it("masks emails only when asked", () => {
    assert.equal(redactText("mail me: a.b@example.com", on).count, 0);
    assert.equal(redactText("mail me: a.b@example.com", { secrets: false, emails: true }).text, "mail me: [REDACTED:email]");
  });
});

describe("redactToolResult", () => {
  it("masks text content and structuredContent, and counts both", () => {
    const result = {
      content: [{ type: "text", text: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" }, { type: "image", data: "AKIAIOSFODNN7EXAMPLE" }],
      structuredContent: { nested: { key: "AKIAIOSFODNN7EXAMPLE" } },
    };
    const { result: out, count } = redactToolResult(result, on);
    assert.equal(count, 2);
    assert.match((out.content[0] as { text: string }).text, /REDACTED/);
    assert.equal((out.content[1] as { data: string }).data, "AKIAIOSFODNN7EXAMPLE", "binary content is not touched");
    assert.deepEqual(out.structuredContent, { nested: { key: "[REDACTED:aws-key]" } });
  });

  it("returns the result untouched when masking is off", () => {
    const result = { content: [{ type: "text", text: "AKIAIOSFODNN7EXAMPLE" }] };
    assert.equal(redactToolResult(result, { secrets: false, emails: false }).result, result);
  });
});
