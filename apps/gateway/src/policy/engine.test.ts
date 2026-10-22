import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Policy, TenantId } from "@warden/shared";
import { decide, defaultPolicy, matchesPattern } from "./engine.js";

const base = defaultPolicy("t_test" as TenantId);
const with_ = (p: Partial<Policy>): Policy => ({ ...base, ...p });

describe("matchesPattern", () => {
  it("matches everything with *", () => assert.equal(matchesPattern("fs.read_file", "*"), true));
  it("matches a namespace with ns.*", () => assert.equal(matchesPattern("fs.read_file", "fs.*"), true));
  it("does not let fs.* match a longer namespace", () => assert.equal(matchesPattern("fsx.tool", "fs.*"), false));
  it("matches exact names only", () => {
    assert.equal(matchesPattern("fs.read_file", "fs.read_file"), true);
    assert.equal(matchesPattern("fs.read_file_extra", "fs.read_file"), false);
  });
});

describe("decide", () => {
  it("allows everything under the default policy", () => {
    assert.equal(decide(base, "fs.write_file").verdict, "allow");
  });

  it("denies a tool on the deny list, with a readable reason", () => {
    const d = decide(with_({ deny: ["fs.write_file"] }), "fs.write_file");
    assert.equal(d.verdict, "deny");
    assert.match(d.verdict === "deny" ? d.reason : "", /fs\.write_file/);
  });

  it("blocks tools outside a non-empty allowlist", () => {
    const p = with_({ allow: ["everything.*"] });
    assert.equal(decide(p, "fs.read_file").verdict, "deny");
    assert.equal(decide(p, "everything.echo").verdict, "allow");
  });

  it("lets deny beat allow", () => {
    assert.equal(decide(with_({ allow: ["*"], deny: ["everything.echo"] }), "everything.echo").verdict, "deny");
  });
});
