/**
 * Java and the JVM (`gradle.lockfile`, and `pom.xml`).
 *
 * ## One ecosystem, two build tools
 *
 * Both resolve from the same coordinate space — `group:artifact` on Maven Central — so
 * `com.google.guava:guava` is the same package whether Gradle or Maven fetched it, and both
 * parsers namespace to `maven`. Filing them separately would pay the same maintainer twice
 * under two names and split their standing on the leaderboard.
 *
 * ## Why this ecosystem is the awkward one
 *
 * Every other parser here reads a lockfile that the tool writes by default. The JVM has no
 * such thing. Gradle CAN write `gradle.lockfile`, but only for projects that opt into
 * dependency locking, and Maven has no lockfile at all — `pom.xml` is a manifest, and the
 * transitive graph is resolved at build time against the network.
 *
 * So the two parsers below are honestly unequal, and the difference matters for money:
 *
 *   - `gradle.lockfile` is a real resolved set. Every transitive dependency is named, and the
 *     depth split comes from the version catalog the way Go's comes from `go.mod`.
 *   - `pom.xml` yields DIRECT dependencies only. A Maven project funds the libraries it names
 *     and nothing underneath them, because nothing underneath them is written down anywhere on
 *     the machine. That underpays deep transitive maintainers in Maven projects relative to
 *     every other ecosystem, and the alternative — resolving the graph ourselves — needs the
 *     network and every dependency's own POM, which is a build tool, not a status line.
 */
import type { DepEntry } from "@obrigado/shared";

import { safeToml, toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

/** `group:artifact`, dropping the version — the coordinate the API is keyed on. */
function coordinate(groupArtifactVersion: string): string | null {
  const parts = groupArtifactVersion.split(":");
  const [group, artifact] = parts;
  if (group === undefined || artifact === undefined) return null;
  if (group.length === 0 || artifact.length === 0) return null;
  // An unresolved property (`${lib.version}`) means the file cannot tell us the name without
  // running the build. Guessing would invent a package.
  if (group.includes("${") || artifact.includes("${")) return null;
  return `${group}:${artifact}`;
}

/**
 * Every coordinate in a `gradle.lockfile`.
 *
 * The format is one `group:artifact:version=configuration,configuration` per line, with a
 * three-line comment header and a trailing `empty=` naming the configurations that resolved
 * to nothing. Both are skipped: `empty` is not a package.
 */
function fromGradleLock(lockfile: string): Set<string> {
  const found = new Set<string>();

  for (const raw of lockfile.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const left = line.split("=")[0];
    if (left === undefined || left === "empty") continue;

    const name = coordinate(left);
    if (name !== null) found.add(name);
  }
  return found;
}

/** What a Gradle version catalog declares — the closest thing the format has to "direct". */
interface VersionCatalog {
  readonly libraries?: Record<string, unknown>;
}

/**
 * Direct dependencies from `gradle/libs.versions.toml`.
 *
 * A catalog entry is either `{ module = "group:artifact" }` or the split
 * `{ group = "…", name = "…" }`; both spellings are current and projects mix them. A bare
 * string value is also legal shorthand.
 *
 * The catalog is not the whole truth — a build file can declare a dependency without going
 * through it — so this only ever PROMOTES something to depth 0. Anything it misses stays at
 * depth 1, which is the same direction Go's `// indirect` handling errs in.
 */
function fromVersionCatalog(manifest: string): Set<string> {
  const direct = new Set<string>();
  const parsed = safeToml<VersionCatalog>(manifest);
  if (parsed === null) return direct;

  for (const entry of Object.values(parsed.libraries ?? {})) {
    if (typeof entry === "string") {
      const name = coordinate(entry);
      if (name !== null) direct.add(name);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;

    const record = entry as Record<string, unknown>;
    const module = record["module"];
    if (typeof module === "string") {
      const name = coordinate(module);
      if (name !== null) direct.add(name);
      continue;
    }

    const group = record["group"];
    const artifact = record["name"];
    if (typeof group === "string" && typeof artifact === "string") {
      const name = coordinate(`${group}:${artifact}`);
      if (name !== null) direct.add(name);
    }
  }
  return direct;
}

export const gradleParser: LockfileParser = {
  ecosystem: "maven",
  lockfile: "gradle.lockfile",
  manifest: "gradle/libs.versions.toml",

  parse({ lockfile, manifest }: ParserInput): DepEntry[] {
    const resolved = fromGradleLock(lockfile);
    const direct = manifest === undefined ? new Set<string>() : fromVersionCatalog(manifest);

    const depths = new Map<string, number>();
    for (const name of resolved) depths.set(name, direct.has(name) ? 0 : 1);
    // A catalogued library the lock did not resolve still counts: the developer chose it.
    for (const name of direct) depths.set(name, 0);

    return toDeps("maven", depths);
  },
};

/**
 * `<dependency>` blocks in a POM, minus the ones that are not dependencies.
 *
 * Regex rather than an XML parser, and the trade is deliberate: adding an XML dependency to a
 * client that ships as a 60MB binary to read one optional file is a poor bargain, and the
 * shape being matched is the least ambiguous part of the format. What it costs is that a POM
 * doing something genuinely clever is read as though it were plain — and the failure mode of
 * that is naming fewer packages, never inventing one.
 *
 * Two exclusions do real work:
 *
 *   - `<dependencyManagement>` declares versions for dependencies that may never be used. Its
 *     entries are not dependencies of anything and counting them would fund libraries the
 *     project does not ship.
 *   - Comments, because a commented-out dependency is the clearest possible statement that it
 *     is not one.
 */
function fromPom(pom: string): Set<string> {
  const cleaned = pom
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/gu, "");

  const found = new Set<string>();

  for (const block of cleaned.matchAll(/<dependency>([\s\S]*?)<\/dependency>/gu)) {
    const body = block[1] ?? "";
    const group = /<groupId>([\s\S]*?)<\/groupId>/u.exec(body)?.[1]?.trim();
    const artifact = /<artifactId>([\s\S]*?)<\/artifactId>/u.exec(body)?.[1]?.trim();
    if (group === undefined || artifact === undefined) continue;

    const name = coordinate(`${group}:${artifact}`);
    if (name !== null) found.add(name);
  }
  return found;
}

export const mavenParser: LockfileParser = {
  ecosystem: "maven",
  lockfile: "pom.xml",

  parse({ lockfile }: ParserInput): DepEntry[] {
    const depths = new Map<string, number>();
    // Depth 0 for all of them, because a POM names only what the project chose. See the header:
    // the transitive graph is not on disk, and this file does not pretend to know it.
    for (const name of fromPom(lockfile)) depths.set(name, 0);

    return toDeps("maven", depths);
  },
};
