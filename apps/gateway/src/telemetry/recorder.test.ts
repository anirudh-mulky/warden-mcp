import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashArgs, percentile } from "./recorder.js";

describe("percentile (nearest rank)", () => {
  it("is null with nothing to measure", () => assert.equal(percentile([], 95), null));
  it("handles a single value", () => assert.equal(percentile([7], 50), 7));
  it("picks the nearest-rank values", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    assert.equal(percentile(sorted, 50), 50);
    assert.equal(percentile(sorted, 95), 95);
    assert.equal(percentile(sorted, 100), 100);
  });
});

describe("hashArgs", () => {
  it("fingerprints arguments without containing them", () => {
    const h = hashArgs({ password: "hunter2" });
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h.includes("hunter2"), false);
  });
  it("is stable for identical arguments", () => assert.equal(hashArgs({ a: 1 }), hashArgs({ a: 1 })));
});
