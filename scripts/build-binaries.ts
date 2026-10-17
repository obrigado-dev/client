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
 * Built since A46, for x64 and arm64: a console program named `obrigado-<target>.exe`
 * (`release.ts`'s `binaryAsset`), because Windows runs a program by its extension. install.ps1
 * fetches it, and so does install.sh under Git Bash. npm does not carry it: its package managers
 * would put a shim on PATH that runs the launcher with `/bin/sh` (`scripts/npm-packages.ts`).
 * `--windows-hide-console` is not used. It would make a program with no console, whose output a
 * terminal never shows, and the hosts that start the renderer hide its window themselves.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { binaryAsset, RELEASE_DEFINES, RELEASE_TARGETS } from "../packages/client/src/release.ts";

/** The platforms, by the name each release binary is built as (`release.ts`). */
export const TARGETS = RELEASE_TARGETS;

export const ENTRY = "packages/client/src/cli.ts";

/**
 * The `bun build` argv for one target, with the release's compiled-in defaults — the production
 * server among them, so `curl … | sh` produces an install that works without anyone setting
 * OBRIGADO_API_ORIGIN (`packages/client/src/release.ts`) — and which asset it is, which is what
 * the self-update downloads its successor as (A38).
 */
export function compileArgs(name: string, target: string, outfile: string): string[] {
  const defines = Object.entries({
    ...RELEASE_DEFINES,
    OBRIGADO_RELEASE_TARGET: JSON.stringify(name),
  }).flatMap(([define, value]) => ["--define", `${define}=${value}`]);
  return [
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    ...defines,
    ENTRY,
    "--outfile",
    outfile,
  ];
}
export const OUT_DIR = "dist/binaries";

/** `sha256  filename`, the format `sha256sum -c` reads. */
export function checksumLine(digest: string, name: string): string {
  return `${digest}  ${name}`;
}

/* Synchronous throughout, and deliberately: each target shells out to `bun build --compile`
   via `spawnSync`, so the loop is sequential whatever the file APIs look like. Async reads
   here would only be async in appearance.

   Every target, or only those named: `bun scripts/build-binaries.ts windows-x64` is how CI's
   Windows job builds the one it runs (A46). A release builds them all. */
function main(only: readonly string[]): void {
  const unknown = only.filter((name) => !(name in TARGETS));
  if (unknown.length > 0) throw new Error(`no such target: ${unknown.join(", ")}`);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const sums: string[] = [];

  for (const [name, target] of Object.entries(TARGETS)) {
    if (only.length > 0 && !only.includes(name)) continue;
    const outfile = `${OUT_DIR}/${binaryAsset(name)}`;
    const built = Bun.spawnSync(compileArgs(name, target, outfile));

    if (built.exitCode !== 0) {
      process.stderr.write(built.stderr.toString());
      throw new Error(`failed to compile ${target}`);
    }

    const bytes = readFileSync(outfile);
    sums.push(checksumLine(createHash("sha256").update(bytes).digest("hex"), binaryAsset(name)));
    process.stdout.write(`  ${name.padEnd(16)} ${(bytes.byteLength / 1e6).toFixed(1)}MB\n`);
  }

  // One file rather than one per binary: `install.sh` fetches it once and greps the line it
  // needs, so a release has a single checksum artifact to publish and to be audited against.
  writeFileSync(`${OUT_DIR}/SHA256SUMS`, `${sums.join("\n")}\n`);
  process.stdout.write(`\nwrote ${sums.length} binaries and SHA256SUMS to ${OUT_DIR}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
