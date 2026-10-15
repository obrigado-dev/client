/**
 * `bin/obrigado` in @obrigado/client (A44): the shell script that finds the platform package a
 * package manager installed beside it and runs that package's binary.
 *
 * Each layout is the one npm, bun and yarn, or pnpm makes for a global install, built by hand in a
 * directory whose name has a space in it. The "binaries" are scripts that print which build they
 * are and what they were given.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "npm", "obrigado.sh");

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "obrigado npm launcher ")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The build this machine runs, decided the way install.sh decides it. */
function thisMachine(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const cpu = process.arch === "arm64" ? "arm64" : "x64";
  const ldd = Bun.spawnSync(["sh", "-c", "ldd --version 2>&1 || true"]).stdout.toString();
  return os === "linux" && cpu === "x64" && /musl/iu.test(ldd) ? "linux-x64-musl" : `${os}-${cpu}`;
}

/** A platform package in `scope`, whose binary says which build it is and what it was given. */
function platform(scope: string, asset: string, status = 0): void {
  const bin = join(scope, `client-${asset}`, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "obrigado"), `#!/bin/sh\nprintf '%s\\n' ${asset} "$@"\nexit ${status}\n`);
  chmodSync(join(bin, "obrigado"), 0o755);
}

/** @obrigado/client in `dir`, with the launcher as its `bin/obrigado`. */
function client(dir: string): string {
  mkdirSync(join(dir, "bin"), { recursive: true });
  const launcher = join(dir, "bin", "obrigado");
  copyFileSync(LAUNCHER, launcher);
  chmodSync(launcher, 0o755);
  return launcher;
}

/** npm's global layout: the platform package nested inside, and a relative link in `bin`. */
function npmGlobal(): string {
  const own = join(root, "lib", "node_modules", "@obrigado", "client");
  client(own);
  mkdirSync(join(root, "bin"));
  symlinkSync("../lib/node_modules/@obrigado/client/bin/obrigado", join(root, "bin", "obrigado"));
  return join(own, "node_modules", "@obrigado");
}

function run(entry: string, ...args: string[]): { status: number; out: string; err: string } {
  const proc = Bun.spawnSync([entry, ...args], { stdout: "pipe", stderr: "pipe" });
  return { status: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("the launcher", () => {
  test("runs the build npm nested inside @obrigado/client, through npm's link", () => {
    platform(npmGlobal(), thisMachine());

    expect(run(join(root, "bin", "obrigado"), "install", "two words")).toEqual({
      status: 0,
      out: `${thisMachine()}\ninstall\ntwo words\n`,
      err: "",
    });
  });

  test("runs the build bun and yarn hoisted beside it", () => {
    const scope = join(root, "global", "node_modules", "@obrigado");
    const launcher = client(join(scope, "client"));
    platform(scope, thisMachine());
    symlinkSync(launcher, join(root, "obrigado"));

    expect(run(join(root, "obrigado"), "version").out).toBe(`${thisMachine()}\nversion\n`);
  });

  test("runs the build pnpm linked beside it in its store, through pnpm's shim", () => {
    const asset = thisMachine();
    const store = join(root, "pnpm", "global", "5", "node_modules", ".pnpm");
    const own = join(store, "@obrigado+client@1.2.3", "node_modules", "@obrigado");
    client(join(own, "client"));
    const theirs = join(store, `@obrigado+client-${asset}@1.2.3`, "node_modules", "@obrigado");
    platform(theirs, asset);
    symlinkSync(join(theirs, `client-${asset}`), join(own, `client-${asset}`));
    const linked = join(root, "pnpm", "global", "5", "node_modules", "@obrigado");
    mkdirSync(linked);
    symlinkSync(join(own, "client"), join(linked, "client"));
    const shim = join(root, "pnpm", "obrigado");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec /bin/sh "${join(linked, "client", "bin", "obrigado")}" "$@"\n`,
    );
    chmodSync(shim, 0o755);

    expect(run(shim, "version").out).toBe(`${asset}\nversion\n`);
  });

  test("chooses this machine's build when more than one was installed", () => {
    const scope = npmGlobal();
    for (const asset of [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "linux-x64-musl",
    ]) {
      platform(scope, asset);
    }

    expect(run(join(root, "bin", "obrigado")).out).toBe(`${thisMachine()}\n`);
  });

  test("says so when no build for this machine came with it", () => {
    npmGlobal();

    const { status, err } = run(join(root, "bin", "obrigado"), "version");
    expect(status).toBe(1);
    expect(err).toContain("obrigado: @obrigado/client has no build for");
  });

  test("exits as the binary does", () => {
    platform(npmGlobal(), thisMachine(), 7);

    expect(run(join(root, "bin", "obrigado")).status).toBe(7);
  });
});
