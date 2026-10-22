import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Policy, TenantId } from "@warden/shared";
import { decide, defaultPolicy, isPathOutside, matchesPattern } from "./engine.js";

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

  it("asks for approval on matching tools, but deny still wins", () => {
    assert.equal(decide(with_({ approval: ["fs.*"] }), "fs.write_file").verdict, "approval");
    assert.equal(decide(with_({ approval: ["fs.*"], deny: ["fs.write_file"] }), "fs.write_file").verdict, "deny");
    assert.equal(decide(with_({ approval: ["fs.*"] }), "everything.echo").verdict, "allow");
  });
});

describe("argument rules", () => {
  const p = with_({ argRules: [{ tool: "fs.write_file", arg: "path", op: "pathOutside", value: "/sandbox/public" }] });

  it("allows a write inside the folder", () => {
    assert.equal(decide(p, "fs.write_file", { path: "/sandbox/public/notes.md" }).verdict, "allow");
    assert.equal(decide(p, "fs.write_file", { path: "/sandbox/public" }).verdict, "allow");
  });

  it("blocks a write outside the folder, with the rule in the reason", () => {
    const d = decide(p, "fs.write_file", { path: "/sandbox/secret.txt" });
    assert.equal(d.verdict, "deny");
    assert.match(d.verdict === "deny" ? d.reason : "", /is outside "\/sandbox\/public"/);
  });

  it("is not fooled by ../ path traversal", () => {
    assert.equal(decide(p, "fs.write_file", { path: "/sandbox/public/../secret.txt" }).verdict, "deny");
  });

  it("is not fooled by a sibling folder that shares the prefix", () => {
    assert.equal(decide(p, "fs.write_file", { path: "/sandbox/public-evil/x" }).verdict, "deny");
  });

  it("treats relative and missing paths as outside (fail closed)", () => {
    assert.equal(decide(p, "fs.write_file", { path: "notes.md" }).verdict, "deny");
    assert.equal(decide(p, "fs.write_file", {}).verdict, "deny");
  });

  it("only applies to the tools it names", () => {
    assert.equal(decide(p, "fs.read_text_file", { path: "/etc/passwd" }).verdict, "allow");
  });

  it("ignores argument rules when deciding tools/list visibility (no args yet)", () => {
    assert.equal(decide(p, "fs.write_file").verdict, "allow");
  });

  it("supports the string operators", () => {
    const rule = (op: "equals" | "contains" | "startsWith" | "notStartsWith", value: string) =>
      with_({ argRules: [{ tool: "*", arg: "q", op, value }] });
    assert.equal(decide(rule("contains", "DROP"), "db.query", { q: "DROP TABLE x" }).verdict, "deny");
    assert.equal(decide(rule("equals", "prod"), "db.query", { q: "prod" }).verdict, "deny");
    assert.equal(decide(rule("startsWith", "rm "), "sh.run", { q: "rm -rf /" }).verdict, "deny");
    assert.equal(decide(rule("notStartsWith", "SELECT"), "db.query", { q: "SELECT 1" }).verdict, "allow");
  });
});

describe("isPathOutside", () => {
  it("normalises before comparing", () => {
    assert.equal(isPathOutside("/a/b/./c", "/a/b"), false);
    assert.equal(isPathOutside("/a/b/../../etc", "/a/b"), true);
    assert.equal(isPathOutside("/a/b/c", "/a/b/"), false);
  });
});
