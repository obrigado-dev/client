/**
 * The CLI on npm (A44): the packages `npm install -g @obrigado/client` resolves, made from a release.
 *
 * One package per release binary carries it byte for byte, the file install.sh fetches and the
 * release's signed SHA256SUMS describe, and declares the `os`, `cpu` and `libc` it runs on.
 * `@obrigado/client` names every one of them as an optional dependency at its own exact version,
 * so a package manager installs it with the single one that fits, and ships `bin/obrigado`, a shell
 * script (`npm/obrigado.sh`) that finds that one and runs it.
 *
 * The binary goes on updating itself where the package manager put it (A38): an npm install is the
 * same release binary, and the next release's bytes are the ones npm would install anyway.
 *
 * Nothing here is compiled into the binary. `scripts/npm-packages.ts` lays the packages out from a
 * release's assets and `release.yml` publishes them; they are described here so the tests hold them.
 */

const NPM_NAME = "@obrigado/client";

interface Platform {
  readonly os: "darwin" | "linux";
  readonly cpu: "arm64" | "x64";
  readonly libc?: "glibc" | "musl";
}

/**
 * Keyed by release asset, `obrigado-<key>`: the names `scripts/build-binaries.ts` builds, which
 * the script refuses to publish without.
 *
 * `libc` keeps a package manager that reads it from installing both Linux x64 builds, which
 * matters because Bun's glibc build segfaults on musl. One that ignores it installs both, and the
 * launcher chooses between them as install.sh does.
 */
export const NPM_PLATFORMS: Readonly<Record<string, Platform>> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "linux-x64-musl": { os: "linux", cpu: "x64", libc: "musl" },
};

function platformPackageName(asset: string): string {
  return `${NPM_NAME}-${asset}`;
}

export interface NpmManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly repository: { readonly type: string; readonly url: string; readonly directory: string };
  readonly bin?: Readonly<Record<string, string>>;
  readonly os: readonly string[];
  readonly cpu: readonly string[];
  readonly libc?: readonly string[];
  readonly files: readonly string[];
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** Where every package says it comes from; npm holds a provenance attestation to `repository`. */
const ORIGIN = {
  license: "Apache-2.0",
  homepage: "https://obrigado.dev",
  bugs: { url: "https://github.com/obrigado-dev/client/issues" },
  repository: {
    type: "git",
    url: "https://github.com/obrigado-dev/client.git",
    directory: "packages/client",
  },
} as const;

export function platformManifest(asset: string, version: string): NpmManifest {
  const platform = NPM_PLATFORMS[asset];
  if (platform === undefined) throw new Error(`no npm package for obrigado-${asset}`);
  return {
    name: platformPackageName(asset),
    version,
    description: `The obrigado CLI's ${asset} binary. Install ${NPM_NAME}, which picks it for you.`,
    ...ORIGIN,
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc === undefined ? {} : { libc: [platform.libc] }),
    files: ["bin"],
  };
}

export function mainManifest(version: string): NpmManifest {
  return {
    name: NPM_NAME,
    version,
    description:
      "One sponsored line in your coding agent's status bar, paying the open source maintainers of the packages you use.",
    ...ORIGIN,
    bin: { obrigado: "bin/obrigado" },
    // A Windows machine is told so by its package manager, rather than given a script it cannot run.
    os: ["darwin", "linux"],
    cpu: ["arm64", "x64"],
    files: ["bin"],
    optionalDependencies: Object.fromEntries(
      Object.keys(NPM_PLATFORMS).map((asset) => [platformPackageName(asset), version]),
    ),
  };
}

/** The page npm shows for a platform package, which nobody should install by name. */
export function platformReadme(asset: string): string {
  return [
    `# ${platformPackageName(asset)}`,
    "",
    `The obrigado CLI built for ${asset}: the \`obrigado-${asset}\` binary of the GitHub release with`,
    "this version, byte for byte, as that release's signed `SHA256SUMS` describe it.",
    "",
    `Install [\`${NPM_NAME}\`](https://www.npmjs.com/package/${NPM_NAME}) instead. It depends on`,
    "this package and runs it on the machines it fits. https://obrigado.dev",
    "",
  ].join("\n");
}
