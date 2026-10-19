import { expect, test } from "bun:test";

import { browserBuildTarget } from "../scripts/build-target.ts";

test("release builds keep the production origin, permissions and output", () => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- an absent override is the release case
  expect(browserBuildTarget(undefined)).toEqual({
    origin: "https://obrigado.dev",
    permission: "https://obrigado.dev/*",
    outDir: ".output",
  });
});

test("local builds isolate their output and request loopback access", () => {
  expect(browserBuildTarget("http://127.0.0.1:3599")).toEqual({
    origin: "http://127.0.0.1:3599",
    permission: "http://127.0.0.1/*",
    outDir: ".output/e2e",
  });
});

test("a test override cannot redirect the extension to a remote or ambiguous origin", () => {
  for (const origin of [
    "https://example.com",
    "http://127.0.0.1.evil.test",
    "http://user:pass@localhost",
    "http://localhost/api",
    "http://localhost/?key=secret",
    "http://localhost/#x",
  ]) {
    expect(() => browserBuildTarget(origin)).toThrow();
  }
});
