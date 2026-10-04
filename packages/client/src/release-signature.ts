/**
 * Signed releases (§3, A38): an Ed25519 signature over each release's SHA256SUMS.
 *
 * The checksums alone stop a corrupted or swapped download, but they arrive from the same release
 * as the binaries they describe, so they cannot stop a bad release. The signature can. It is made
 * in `release.yml` with a private key that exists only as the repository secret
 * `RELEASE_SIGNING_KEY`, and checked against the public keys below, which are compiled into every
 * binary. A release whose checksums are not signed by one of them is one the self-update refuses.
 *
 * ## The keys
 *
 * More than one may be listed, so a key can be replaced without stranding anybody: ship a release
 * that lists the old key and the new one, sign from then on with the new one, and drop the old
 * one a release later. Each is the SubjectPublicKeyInfo DER of an Ed25519 key, base64-encoded,
 * as `scripts/release-key.ts` prints it.
 *
 * Losing the private key is not recoverable by a release: installs trust only these keys, so a
 * release signed by any other is refused, and they stop updating until somebody reinstalls. The
 * key is backed up outside the repository for that reason.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** The keys a release may be signed with. See the header before changing this. */
export const RELEASE_KEYS: readonly string[] = [
  // Made 2026-10-04. Private half: the secret RELEASE_SIGNING_KEY, and its backup.
  "MCowBQYDK2VwAyEAdcom3al12hkdre1jeIuaX8GXMSApPzJOOPW0k2PT1qQ=",
];

/** The file a release publishes beside SHA256SUMS: the signature, base64, on one line. */
export const SIGNATURE_ASSET = "SHA256SUMS.sig";

/** The signature over `sums` with a PKCS#8 PEM private key, as `SHA256SUMS.sig` holds it. */
export function signSums(sums: Uint8Array, privateKeyPem: string): string {
  return `${sign(null, sums, createPrivateKey(privateKeyPem)).toString("base64")}\n`;
}

/**
 * Whether `signature` (the text of `SHA256SUMS.sig`) is a signature over exactly `sums` by one of
 * `keys`. Anything malformed is false: a signature that cannot be read is no signature.
 */
export function verifySums(
  sums: Uint8Array,
  signature: string,
  keys: readonly string[] = RELEASE_KEYS,
): boolean {
  const bytes = Buffer.from(signature.trim(), "base64");
  if (bytes.length !== 64) return false;
  return keys.some((key) => {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      });
      return verify(null, sums, publicKey, bytes);
    } catch {
      return false;
    }
  });
}
