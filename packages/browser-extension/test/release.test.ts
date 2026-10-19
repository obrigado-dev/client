import { expect, test } from "bun:test";

import { browserRelease, verifyReleaseManifest } from "../scripts/release.ts";

test("browser releases use their own version and tag namespace", () => {
  expect(browserRelease("0.1.0", "browser-extension-v0.1.0")).toEqual({
    version: "0.1.0",
    zip: "obrigado-browser-0.1.0-chrome.zip",
  });
  for (const tag of ["v0.1.0", "surface-v0.1.0", "browser-extension-v0.2.0", "main"]) {
    expect(() => browserRelease("0.1.0", tag)).toThrow("does not match");
  }
});

test("release versions fit Chrome's numeric version format", () => {
  for (const version of ["0.0.0", "1.0", "01.0.0", "1.0.0-beta.1", "65536.0.0", "1.0.0\nx=y"]) {
    expect(() => browserRelease(version, `browser-extension-v${version}`)).toThrow();
  }
});

test("a release rejects the wrong version or a local integration build", () => {
  const manifest = {
    manifest_version: 3,
    version: "0.1.0",
    host_permissions: ["https://obrigado.dev/*"],
  };
  expect(() => verifyReleaseManifest(manifest, "0.1.0")).not.toThrow();
  for (const invalid of [
    null,
    {},
    { ...manifest, version: "0.2.0" },
    { ...manifest, manifest_version: 2 },
    { ...manifest, host_permissions: ["http://127.0.0.1/*"] },
    { ...manifest, host_permissions: ["https://obrigado.dev/*", "<all_urls>"] },
  ]) {
    expect(() => verifyReleaseManifest(invalid, "0.1.0")).toThrow();
  }
});
