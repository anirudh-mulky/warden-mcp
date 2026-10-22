import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSafeUrl, isPrivateAddress, UnsafeUrlError } from "./guard.js";

describe("isPrivateAddress", () => {
  it("flags loopback, private ranges, link-local and cloud metadata", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  it("lets public addresses through", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
});

describe("assertSafeUrl", () => {
  const rejects = (url: string) => assert.rejects(assertSafeUrl(url), UnsafeUrlError, url);

  it("refuses non-http schemes, credentials in URLs and plain http", async () => {
    await rejects("file:///etc/passwd");
    await rejects("https://user:pass@example.com/");
    await rejects("http://example.com/hook");
  });

  it("refuses literal internal addresses, including the metadata endpoint", async () => {
    await rejects("https://127.0.0.1/hook");
    await rejects("https://169.254.169.254/latest/meta-data/");
    await rejects("https://[::1]/hook");
  });

  it("refuses names that resolve to internal addresses", async () => {
    await rejects("https://localhost/hook");
  });
});
