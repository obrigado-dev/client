#!/usr/bin/env bun
/**
 * Make a release signing key (A38): `bun scripts/release-key.ts <path for the private key>`.
 *
 * Writes the private key, PKCS#8 PEM, to the path given, readable by its owner alone, and prints
 * the public key in the form `RELEASE_KEYS` in `packages/client/src/release-signature.ts` lists.
 * The private key is never printed. It belongs in the repository secret `RELEASE_SIGNING_KEY`
 * and in a backup kept outside the repository, and nowhere else: see that module's header for
 * why losing it strands every install on the version it has.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("usage: bun scripts/release-key.ts <path for the private key>\n");
  process.exit(1);
}
// A key is never overwritten: the one already there may be the only copy.
if (existsSync(path)) {
  process.stderr.write(`${path} already exists; not overwriting it\n`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
process.stdout.write(`${publicKey.export({ format: "der", type: "spki" }).toString("base64")}\n`);
