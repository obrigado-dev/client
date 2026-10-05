/**
 * A file from one of this repository's releases, checked before anything trusts it (§3, A38).
 *
 * The self-update takes the binary this way, and the editor installs take the `.vsix` the same
 * way (A40): the release's SHA256SUMS, signed by a key compiled into this client, then the file's
 * digest against it. Split from `self-update.ts` so the two cannot verify differently.
 */
import { createHash } from "node:crypto";

import { SIGNATURE_ASSET, verifySums } from "./release-signature.ts";

export const REPO = "obrigado-dev/client";
const REQUEST_TIMEOUT_MS = 20_000;
/** A binary is ~60MB; a slow connection gets minutes, not the request timeout. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReleaseDeps {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** This client's version, for the user agent GitHub asks callers to send. */
  readonly current: string;
  /** The keys a release must be signed with; the compiled-in `RELEASE_KEYS` when not given. */
  readonly keys?: readonly string[];
}

export function parseVersion(text: string): readonly [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(text.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is a later version than `current`; false when either is not one. */
export function isNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (next === null || now === null) return false;
  for (const index of [0, 1, 2] as const) {
    if (next[index] !== now[index]) return next[index] > now[index];
  }
  return false;
}

/** The digest SHA256SUMS lists for `asset`, in the `digest  name` form `sha256sum` writes. */
export function checksumFor(sums: string, asset: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *]?(\S+)$/u.exec(line.trim());
    if (match?.[2] === asset) return match[1] ?? null;
  }
  return null;
}

/** The latest release that is not a pre-release, as its tag (`v1.2.3`), or null. */
export async function latestReleaseTag(deps: ReleaseDeps): Promise<string | null> {
  try {
    const response = await deps.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `obrigado/${deps.current}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown; prerelease?: unknown };
    const tag = body.tag_name;
    return typeof tag === "string" && body.prerelease !== true && parseVersion(tag) !== null
      ? tag
      : null;
  } catch {
    return null;
  }
}

async function download(deps: ReleaseDeps, url: string): Promise<Uint8Array | null> {
  try {
    const response = await deps.fetch(url, {
      headers: { "user-agent": `obrigado/${deps.current}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    // HTTPS from the first byte to the last, as install.sh insists: a redirect to plain http
    // would otherwise be followed silently, and the checksums travel the same way.
    if (!response.ok || !response.url.startsWith("https://")) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

export type VerifiedAsset =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

/**
 * `asset` from release `tag`, matched against that release's signed checksums.
 *
 * `from` is where the bytes are fetched, GitHub when not given. The checksums and their signature
 * always come from GitHub, so a redirect in front of the asset, obrigado.dev's counting one
 * (A40), is trusted for nothing: bytes that do not match are refused wherever they came from.
 */
export async function verifiedAsset(
  deps: ReleaseDeps,
  tag: string,
  asset: string,
  from?: string,
): Promise<VerifiedAsset> {
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const [bytes, sums, signature] = await Promise.all([
    download(deps, from ?? `${base}/${asset}`),
    download(deps, `${base}/SHA256SUMS`),
    download(deps, `${base}/${SIGNATURE_ASSET}`),
  ]);
  if (bytes === null || sums === null) return { ok: false, reason: `could not download ${tag}` };
  // The checksums are only as good as their signature: they arrive from the same release as the
  // file they describe, so unsigned they would vouch for whatever was published.
  if (signature === null || !verifySums(sums, new TextDecoder().decode(signature), deps.keys)) {
    return { ok: false, reason: `${tag} is not signed by a release key: not installed` };
  }

  const expected = checksumFor(new TextDecoder().decode(sums), asset);
  if (expected === null) return { ok: false, reason: `${tag} publishes no checksum for ${asset}` };
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    return { ok: false, reason: `checksum mismatch for ${asset}: not installed` };
  }
  return { ok: true, bytes };
}
