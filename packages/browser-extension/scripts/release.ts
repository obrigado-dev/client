/** Release guards shared by CI and local packaging; no store credentials are read here. */
import { appendFileSync } from "node:fs";

export function browserRelease(version: string, tag: string) {
  const parts = version.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^(?:0|[1-9]\d*)$/u.test(part) || Number(part) > 65_535) ||
    version === "0.0.0"
  ) {
    throw new Error("The browser version must have three Chrome-compatible numeric components");
  }
  if (tag !== `browser-extension-v${version}`) {
    throw new Error(`Tag ${tag} does not match browser-extension-v${version}`);
  }
  return { version, zip: `obrigado-browser-${version}-chrome.zip` };
}

export function verifyReleaseManifest(manifest: unknown, version: string): void {
  const value = manifest as Record<string, unknown> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    value["manifest_version"] !== 3 ||
    value["version"] !== version ||
    JSON.stringify(value["host_permissions"]) !== JSON.stringify(["https://obrigado.dev/*"])
  ) {
    throw new Error(
      "The release ZIP must contain the tagged MV3 version with production API access",
    );
  }
}

if (import.meta.main) {
  const { version } = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
  };
  const target = browserRelease(version, process.env["RELEASE_TAG"] ?? "");
  if (process.argv[2] === "target") {
    const output = process.env["GITHUB_OUTPUT"];
    if (output !== undefined) {
      appendFileSync(output, `version=${target.version}\nzip=${target.zip}\n`);
    }
    console.log(JSON.stringify(target));
  } else if (process.argv[2] === "verify" && process.argv[3] !== undefined) {
    verifyReleaseManifest(await Bun.file(process.argv[3]).json(), version);
    console.log(`Verified production Chrome manifest ${version}`);
  } else {
    throw new Error(
      "Usage: RELEASE_TAG=browser-extension-v<version> bun scripts/release.ts target|verify <manifest>",
    );
  }
}
