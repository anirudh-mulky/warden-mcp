import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("passwords", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    assert.equal(await verifyPassword("correct horse battery", stored), true);
    assert.equal(await verifyPassword("correct horse batterY", stored), false);
  });

  it("salts: the same password hashes differently each time", async () => {
    assert.notEqual(await hashPassword("same password"), await hashPassword("same password"));
  });

  it("never stores the password itself", async () => {
    const stored = await hashPassword("visible-secret-123");
    assert.equal(stored.includes("visible-secret-123"), false);
    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$/);
  });

  it("rejects garbage instead of throwing", async () => {
    assert.equal(await verifyPassword("x", "not-a-hash"), false);
  });
});
