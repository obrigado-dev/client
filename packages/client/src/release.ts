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
