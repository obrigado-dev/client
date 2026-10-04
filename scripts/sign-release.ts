#!/usr/bin/env bun
/**
 * Sign a release's checksums, or check a signature (A38).
 *
 *   bun scripts/sign-release.ts                    sign dist/binaries/SHA256SUMS
 *   bun scripts/sign-release.ts --verify <dir>     check <dir>/SHA256SUMS against its .sig
 *
 * Signing reads the private key from `OBRIGADO_RELEASE_SIGNING_KEY` (`release.yml` passes the
 * secret `RELEASE_SIGNING_KEY`) and refuses without one: there is no unsigned release, because
 * every install that updates itself would refuse it anyway. It then checks its own signature
 * against the keys compiled into the client, so a secret that does not match the committed key
 * fails here, before anything is published, rather than on every install after.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SIGNATURE_ASSET, signSums, verifySums } from "../packages/client/src/release-signature.ts";
import { OUT_DIR } from "./build-binaries.ts";

function check(dir: string): void {
  const sums = readFileSync(join(dir, "SHA256SUMS"));
  const signature = readFileSync(join(dir, SIGNATURE_ASSET), "utf8");
  if (!verifySums(sums, signature)) {
    throw new Error(`${dir}/SHA256SUMS is not signed by a key in RELEASE_KEYS`);
  }
  process.stdout.write(`${dir}/SHA256SUMS: signature verified\n`);
}

const verifyAt = process.argv.indexOf("--verify");
if (verifyAt >= 0) {
  check(process.argv[verifyAt + 1] ?? OUT_DIR);
} else {
  const key = process.env["OBRIGADO_RELEASE_SIGNING_KEY"];
  if (key === undefined || key.trim() === "") {
    throw new Error(
      "OBRIGADO_RELEASE_SIGNING_KEY is not set: refusing to make an unsigned release",
    );
  }
  const sums = readFileSync(join(OUT_DIR, "SHA256SUMS"));
  writeFileSync(join(OUT_DIR, SIGNATURE_ASSET), signSums(sums, key));
  check(OUT_DIR);
}
