/**
 * Signed releases (A38): what `release.yml` signs, the self-update verifies, and nothing else.
 */
import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";

import { RELEASE_KEYS, signSums, verifySums } from "../src/release-signature.ts";

const SUMS = new TextEncoder().encode(`${"a".repeat(64)}  obrigado-darwin-arm64\n`);

function pair(): { readonly pem: string; readonly key: string } {
  const keys = generateKeyPairSync("ed25519");
  return {
    pem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

describe("a release signature", () => {
  test("verifies against the key that made it", () => {
    const release = pair();
    expect(verifySums(SUMS, signSums(SUMS, release.pem), [release.key])).toBe(true);
  });

  test("does not verify against any other key", () => {
    const release = pair();
    expect(verifySums(SUMS, signSums(SUMS, release.pem), [pair().key])).toBe(false);
  });

  test("does not verify for checksums it was not made over", () => {
    const release = pair();
    const other = new TextEncoder().encode(`${"b".repeat(64)}  obrigado-darwin-arm64\n`);
    expect(verifySums(other, signSums(SUMS, release.pem), [release.key])).toBe(false);
  });

  test("is one base64 line, which is what the release publishes", () => {
    expect(signSums(SUMS, pair().pem)).toMatch(/^[A-Za-z0-9+/]{86}==\n$/u);
  });

  test("that cannot be read is no signature", () => {
    const release = pair();
    for (const bad of ["", "not base64 at all", Buffer.alloc(63).toString("base64")]) {
      expect(verifySums(SUMS, bad, [release.key])).toBe(false);
    }
    expect(verifySums(SUMS, signSums(SUMS, release.pem), ["not a key"])).toBe(false);
  });

  test("passes with any one of several keys, which is how a key is replaced", () => {
    const old = pair();
    const next = pair();
    expect(verifySums(SUMS, signSums(SUMS, next.pem), [old.key, next.key])).toBe(true);
  });
});

describe("the keys compiled into the client", () => {
  test("are Ed25519 public keys, and there is at least one", () => {
    expect(RELEASE_KEYS.length).toBeGreaterThan(0);
    for (const key of RELEASE_KEYS) {
      const parsed = createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      });
      expect(parsed.asymmetricKeyType).toBe("ed25519");
    }
  });
});
