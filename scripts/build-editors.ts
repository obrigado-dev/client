/**
 * Build the two editor surfaces into the release, beside the binaries (A40).
 *
 * Neither editor has a store listing: the VS Code Marketplace publisher and the JetBrains
 * Marketplace vendor are both unclaimed, and JetBrains' review may refuse a sponsored line
 * anyway. So each release carries both, obrigado.dev serves them (a plugin repository for
 * JetBrains IDEs, a `.vsix` the CLI installs for VS Code and Cursor), and nothing waits on a
 * store.
 *
 * Both are stamped with the CLI's version. One number for everything a release contains means
 * an editor never needs its own bookkeeping, and an install that updates itself takes the
 * editor build of the same release. The repository keeps `0.0.0` in both manifests; a build
 * from a checkout is never one an install should prefer.
 *
 * Runs after `build-binaries.ts`, into the same directory, and appends to its SHA256SUMS before
 * `sign-release.ts` signs it, so the editor builds are covered by the same signature as the
 * binaries: the CLI checks a `.vsix` against it before installing one.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { checksumLine, OUT_DIR } from "./build-binaries.ts";

/** What `editors.json` says, which is all obrigado.dev knows about a release's editors. */
export interface EditorManifest {
  readonly version: string;
  readonly jetbrains: {
    readonly id: string;
    readonly file: string;
    readonly sinceBuild: string;
    readonly untilBuild: string | null;
  };
  readonly vscode: { readonly id: string; readonly file: string };
}

const VSCODE_DIR = "packages/vscode-extension";
const JETBRAINS_DIR = "packages/jetbrains-plugin";

function run(command: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout.toString());
    process.stderr.write(result.stderr.toString());
    throw new Error(`${command.join(" ")} failed in ${cwd}`);
  }
  return result.stdout.toString();
}

/** The package's own `vsce`, never one `bun x` would fetch: the unscoped `vsce` is abandoned. */
function vsce(): string {
  for (const candidate of [`${VSCODE_DIR}/node_modules/.bin/vsce`, "node_modules/.bin/vsce"]) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error("vsce is not installed: run bun install");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The plugin's own declaration of which builds it supports, read out of the built plugin.
 *
 * Read rather than restated, so the repository feed can only ever offer the plugin to the IDEs
 * the plugin itself says it runs in. The descriptor is inside the plugin's jar, inside the zip.
 */
export function ideaVersion(pluginXml: string): { sinceBuild: string; untilBuild: string | null } {
  const tag = /<idea-version\b[^>]*>/u.exec(pluginXml)?.[0];
  const since = tag === undefined ? undefined : /since-build="([^"]+)"/u.exec(tag)?.[1];
  if (tag === undefined || since === undefined) {
    throw new Error("the built plugin.xml declares no since-build");
  }
  return { sinceBuild: since, untilBuild: /until-build="([^"]+)"/u.exec(tag)?.[1] ?? null };
}

function pluginId(pluginXml: string): string {
  const id = /<id>([^<]+)<\/id>/u.exec(pluginXml)?.[1];
  if (id === undefined) throw new Error("the built plugin.xml declares no id");
  return id;
}

function main(): void {
  const version = (
    JSON.parse(readFileSync("packages/client/package.json", "utf8")) as { version: string }
  ).version;
  if (!existsSync(`${OUT_DIR}/SHA256SUMS`)) {
    throw new Error(`run build-binaries.ts first: ${OUT_DIR}/SHA256SUMS is missing`);
  }

  const vsix = `obrigado-vscode-${version}.vsix`;
  run(["bun", "run", "build"], VSCODE_DIR);
  run(
    [
      vsce(),
      "package",
      version,
      "--no-dependencies",
      "--no-git-tag-version",
      "--no-update-package-json",
      "--out",
      resolve(OUT_DIR, vsix),
    ],
    VSCODE_DIR,
  );

  const zip = `obrigado-jetbrains-${version}.zip`;
  run(["./gradlew", "buildPlugin", `-PpluginVersion=${version}`, "--quiet"], JETBRAINS_DIR);
  copyFileSync(join(JETBRAINS_DIR, "build/distributions", zip), join(OUT_DIR, zip));
  const jar = `obrigado-jetbrains/lib/obrigado-jetbrains-${version}.jar`;
  run(["unzip", "-o", "-q", resolve(OUT_DIR, zip), jar, "-d", "build/release"], JETBRAINS_DIR);
  const pluginXml = run(
    ["unzip", "-p", `build/release/${jar}`, "META-INF/plugin.xml"],
    JETBRAINS_DIR,
  );

  const manifest: EditorManifest = {
    version,
    jetbrains: { id: pluginId(pluginXml), file: zip, ...ideaVersion(pluginXml) },
    vscode: {
      id: `${readManifest(VSCODE_DIR).publisher}.${readManifest(VSCODE_DIR).name}`,
      file: vsix,
    },
  };
  writeFileSync(join(OUT_DIR, "editors.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const lines = [vsix, zip, "editors.json"].map((name) =>
    checksumLine(sha256(join(OUT_DIR, name)), name),
  );
  appendFileSync(`${OUT_DIR}/SHA256SUMS`, `${lines.join("\n")}\n`);
  process.stdout.write(`wrote ${vsix}, ${zip} and editors.json to ${OUT_DIR}\n`);
}

function readManifest(dir: string): { publisher: string; name: string } {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    publisher: string;
    name: string;
  };
}

if (import.meta.main) main();
