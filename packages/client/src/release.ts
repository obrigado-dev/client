/**
 * What a released binary is compiled with, and nothing a checkout runs with.
 *
 * `scripts/build-binaries.ts` passes these to `bun build --compile` as `--define`s. The server is
 * the one that matters: `obrigado install` saves the origin it resolves, so a release that
 * defaulted to the local stack would register every real install against nothing. A checkout is
 * never built this way and keeps defaulting to the local stack (`config.ts`).
 *
 * `scripts/build-binaries.ts` also compiles in `OBRIGADO_RELEASE_TARGET`, which asset a binary
 * is, per platform rather than here: it is what the self-update downloads (A38).
 */
export const RELEASE_DEFINES = {
  OBRIGADO_RELEASE_API_ORIGIN: JSON.stringify("https://obrigado.dev"),
} as const;

/**
 * The platforms a release is built for, keyed by the name `install.sh` builds from
 * `uname -s`/`uname -m`, each with the `bun build --compile` target that makes it.
 *
 * The key is the contract: rename one and the installer 404s for that platform only, which
 * is the kind of break that shows up as a support question rather than a failed build. The
 * installers derive the same strings, and `test/build-binaries.test.ts` pins them. Here rather
 * than in `scripts/build-binaries.ts` so that a test can hold them.
 */
export const RELEASE_TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64",
  /* Alpine and the distroless images a lot of agents run inside. Bun's glibc build segfaults
     on musl rather than failing to start, so this is a separate artifact and not a fallback. */
  "linux-x64-musl": "bun-linux-x64-musl",
  /* Keyed by what install.ps1 reads from `PROCESSOR_ARCHITECTURE`, and by what install.sh builds
     from `uname` under Git Bash or MSYS2 (A46). Bun's x64 build picks its instructions at run
     time, so there is no baseline variant to choose between. */
  "windows-x64": "bun-windows-x64",
  "windows-arm64": "bun-windows-arm64",
} as const;

/**
 * The file a release publishes for `target`: `obrigado-<target>`, and `obrigado-<target>.exe`
 * for Windows, which runs a program by its extension (A46).
 *
 * The build writes it under this name, `SHA256SUMS` lists it under this name, and install.sh,
 * install.ps1 and the self-update download it by this name, so a Windows install that asked for
 * the bare name would 404 on that platform alone.
 */
export function binaryAsset(target: string): string {
  return target.startsWith("windows-") ? `obrigado-${target}.exe` : `obrigado-${target}`;
}
