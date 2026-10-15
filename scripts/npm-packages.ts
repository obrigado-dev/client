/**
 * Lay out the CLI's npm packages (A44) from a release's binaries.
 *
 *   bun scripts/npm-packages.ts <assets> <out>
 *
 * <assets> holds the release's `obrigado-<platform>` binaries, already checked against its signed
 * SHA256SUMS: `release.yml` downloads and verifies them first, and so does a publish by hand
 * (docs/PUBLISHING.md). <out> gets one directory per package, each ready for `npm publish <dir>`:
 * `client-<platform>` for the binaries, and `client` for `@obrigado/client`, which goes last
 * because it names the others at this exact version.
 *
 * The version is the manifest's, which `release.yml` has already held the tag to.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  mainManifest,
  NPM_PLATFORMS,
  platformManifest,
  platformReadme,
} from "../packages/client/src/npm-packages.ts";
import type { NpmManifest } from "../packages/client/src/npm-packages.ts";
import { TARGETS } from "./build-binaries.ts";

const LAUNCHER = "packages/client/npm/obrigado.sh";
const README = "packages/client/npm/README.md";

function writePackage(dir: string, manifest: NpmManifest, binary: string, readme: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(binary, join(dir, "bin", "obrigado"));
  chmodSync(join(dir, "bin", "obrigado"), 0o755);
  writeFileSync(join(dir, "README.md"), readme);
  copyFileSync("LICENSE", join(dir, "LICENSE"));
}

function main(assets: string, out: string): void {
  // A platform the release builds and npm does not carry would leave its machines with an
  // install that finds nothing to run.
  const missing = Object.keys(TARGETS).filter((asset) => !(asset in NPM_PLATFORMS));
  if (missing.length > 0) throw new Error(`no npm package for ${missing.join(", ")}`);

  const manifest = JSON.parse(readFileSync("packages/client/package.json", "utf8")) as {
    readonly version: string;
  };
  rmSync(out, { recursive: true, force: true });
  for (const asset of Object.keys(NPM_PLATFORMS)) {
    writePackage(
      join(out, `client-${asset}`),
      platformManifest(asset, manifest.version),
      join(assets, `obrigado-${asset}`),
      platformReadme(asset),
    );
  }
  writePackage(
    join(out, "client"),
    mainManifest(manifest.version),
    LAUNCHER,
    readFileSync(README, "utf8"),
  );
  process.stdout.write(`laid out @obrigado/client ${manifest.version} in ${out}\n`);
}

const [assets, out] = process.argv.slice(2);
if (assets === undefined || out === undefined) {
  process.stderr.write("usage: bun scripts/npm-packages.ts <assets> <out>\n");
  process.exit(2);
}
main(assets, out);
