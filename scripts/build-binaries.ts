/**
 * Compile the CLI to standalone binaries, one per platform, with checksums.
 *
 * ## Why binaries exist at all
 *
 * The client reads npm, pnpm, yarn, bun, cargo, go, python and ruby lockfiles — so most of the
 * people it can pay have no reason to own a Node toolchain, and until this existed the only
 * way to install it was `pnpm add -g`. A Rust developer was being asked to acquire npm in
 * order to fund their Cargo dependencies. `bun build --compile` embeds the runtime, so the
 * result needs nothing installed on the machine it lands on.
 *
 * ## What is deliberately not done
 *
 * `--minify` is off: measured at 59.0MB with and without, because the size is the embedded
 * runtime rather than the code, and unminified frames make a user's stack trace worth reading.
 * `--bytecode` is off because it does not parse this source — it fails on `cli.ts` with
 * `Expected ";" but found ")"`, which is a limitation of the bytecode path and not a fault
 * here.
 *
 * ## Windows
 *
 * Not built. `bun-windows-x64` compiles, but the installer that consumes these is a POSIX
 * shell script, and shipping a binary nothing can fetch is worse than a Windows user reading
 * "use npm" — which still works, and is what the site says.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * The platforms, keyed by the name `install.sh` builds from `uname -s`/`uname -m`.
 *
 * The key is the contract: rename one and the installer 404s for that platform only, which
 * is the kind of break that shows up as a support question rather than a failed build. The
 * installer derives the same strings, and `test/build-binaries.test.ts` pins them.
 */
export const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64",
  /* Alpine and the distroless images a lot of agents run inside. Bun's glibc build segfaults
     on musl rather than failing to start, so this is a separate artifact and not a fallback. */
  "linux-x64-musl": "bun-linux-x64-musl",
} as const;

export const ENTRY = "packages/client/src/cli.ts";
export const OUT_DIR = "dist/binaries";

/** `sha256  filename`, the format `sha256sum -c` reads. */
export function checksumLine(digest: string, name: string): string {
  return `${digest}  ${name}`;
}

/* Synchronous throughout, and deliberately: each target shells out to `bun build --compile`
   via `spawnSync`, so the loop is sequential whatever the file APIs look like. Async reads
   here would only be async in appearance. */
function main(): void {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const sums: string[] = [];

  for (const [name, target] of Object.entries(TARGETS)) {
    const outfile = `${OUT_DIR}/obrigado-${name}`;
    const built = Bun.spawnSync([
      "bun",
      "build",
      "--compile",
      `--target=${target}`,
      ENTRY,
      "--outfile",
      outfile,
    ]);

    if (built.exitCode !== 0) {
      process.stderr.write(built.stderr.toString());
      throw new Error(`failed to compile ${target}`);
    }

    const bytes = readFileSync(outfile);
    sums.push(checksumLine(createHash("sha256").update(bytes).digest("hex"), `obrigado-${name}`));
    process.stdout.write(`  ${name.padEnd(16)} ${(bytes.byteLength / 1e6).toFixed(1)}MB\n`);
  }

  // One file rather than one per binary: `install.sh` fetches it once and greps the line it
  // needs, so a release has a single checksum artifact to publish and to be audited against.
  writeFileSync(`${OUT_DIR}/SHA256SUMS`, `${sums.join("\n")}\n`);
  process.stdout.write(`\nwrote ${sums.length} binaries and SHA256SUMS to ${OUT_DIR}\n`);
}

if (import.meta.main) main();
