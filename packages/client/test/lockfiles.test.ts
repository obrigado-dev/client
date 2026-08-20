import { describe, expect, test } from "bun:test";

import { bunParser } from "../src/lockfiles/bun.ts";
import { cargoParser } from "../src/lockfiles/cargo.ts";
import { computeDepths, depthsWithFallback, MAX_DEPTH } from "../src/lockfiles/graph.ts";
import { goParser } from "../src/lockfiles/go.ts";
import { mergeShallowest, PARSERS } from "../src/lockfiles/index.ts";
import { npmParser } from "../src/lockfiles/npm.ts";
import { packageName, pnpmParser } from "../src/lockfiles/pnpm.ts";
import { poetryParser, requirementName, uvParser } from "../src/lockfiles/python.ts";
import { rubyParser } from "../src/lockfiles/ruby.ts";
import { descriptorName, yarnParser } from "../src/lockfiles/yarn.ts";

/** Depth for one package id, or undefined if absent. */
const depthOf = (deps: Array<{ p: string; d: number }>, id: string): number | undefined =>
  deps.find((dep) => dep.p === id)?.d;

describe("depth from a graph", () => {
  test("breadth-first, so depth is the SHORTEST path", () => {
    // A depth-first walk would assign whatever depth it arrived by, making
    // payouts depend on traversal order — invisible in a test with one path per
    // package, and wrong in every real lockfile.
    const depths = computeDepths({
      roots: ["a"],
      edges: new Map([
        ["a", ["b", "deep1"]],
        ["deep1", ["deep2"]],
        ["deep2", ["b"]],
      ]),
    });
    expect(depths.get("b")).toBe(1);
  });

  test("shallowest wins — direct beats transitive", () => {
    // A package the developer chose is a direct dependency even if something
    // else also pulls it in deep.
    const depths = computeDepths({
      roots: ["chosen"],
      edges: new Map([
        ["chosen", ["mid"]],
        ["mid", ["chosen"]],
      ]),
    });
    expect(depths.get("chosen")).toBe(0);
  });

  test("cycles terminate", () => {
    const depths = computeDepths({
      roots: ["a"],
      edges: new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", ["a", "b"]],
      ]),
    });
    expect([...depths.entries()].toSorted()).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  test("stops at MAX_DEPTH rather than walking forever", () => {
    const edges = new Map<string, string[]>();
    for (let n = 0; n < MAX_DEPTH + 10; n += 1) edges.set(`n${n}`, [`n${n + 1}`]);

    const depths = computeDepths({ roots: ["n0"], edges });
    expect(Math.max(...depths.values())).toBeLessThanOrEqual(MAX_DEPTH);
  });

  test("unreachable packages are INCLUDED, not dropped", () => {
    // Usually an optional or platform-specific dependency whose edge we could
    // not follow. Dropping it would deny a real dependency its allocation.
    const depths = depthsWithFallback({ roots: ["a"], edges: new Map() }, ["a", "orphan"]);
    expect(depths.get("orphan")).toBe(1);
  });
});

describe("npm — package-lock.json", () => {
  test("v3: roots from the root entry, depth from the graph", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { express: "^4" } },
        "node_modules/express": { dependencies: { "body-parser": "^1" } },
        "node_modules/body-parser": { dependencies: { bytes: "^3" } },
        "node_modules/bytes": {},
      },
    });
    const deps = npmParser.parse({ lockfile });

    expect(depthOf(deps, "npm:express")).toBe(0);
    expect(depthOf(deps, "npm:body-parser")).toBe(1);
    expect(depthOf(deps, "npm:bytes")).toBe(2);
  });

  test("install-path nesting is NOT used as depth", () => {
    // A hoisted package sits at node_modules/x however deep it really is, so
    // path nesting would report almost everything as a direct dependency.
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { top: "^1" } },
        "node_modules/top": { dependencies: { hoisted: "^1" } },
        // Hoisted to the top level despite being two levels down.
        "node_modules/hoisted": { dependencies: { deeper: "^1" } },
        "node_modules/top/node_modules/deeper": {},
      },
    });
    const deps = npmParser.parse({ lockfile });

    expect(depthOf(deps, "npm:hoisted")).toBe(1);
    expect(depthOf(deps, "npm:deeper")).toBe(2);
  });

  test("workspace links are excluded — they are not publishable", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "@me/shared": "workspace:*", lodash: "^4" } },
        "node_modules/@me/shared": { link: true },
        "node_modules/lodash": {},
      },
    });
    const deps = npmParser.parse({ lockfile });

    expect(deps.map((dep) => dep.p)).toContain("npm:lodash");
    expect(deps.map((dep) => dep.p)).not.toContain("npm:@me/shared");
  });

  test("v1: the nested tree is walked", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        express: { dependencies: { "body-parser": { dependencies: {} } } },
      },
    });
    const deps = npmParser.parse({ lockfile });
    expect(depthOf(deps, "npm:express")).toBe(0);
    expect(depthOf(deps, "npm:body-parser")).toBe(1);
  });

  test("malformed JSON yields nothing rather than throwing", () => {
    expect(npmParser.parse({ lockfile: "{ not json" })).toEqual([]);
  });
});

describe("pnpm — pnpm-lock.yaml", () => {
  test("v9: roots from importers, edges from snapshots", () => {
    const lockfile = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      vue:
        specifier: ^3
        version: 3.4.0
    devDependencies:
      vite:
        specifier: ^5
        version: 5.0.0
snapshots:
  vue@3.4.0:
    dependencies:
      '@vue/shared': 3.4.0
  '@vue/shared@3.4.0': {}
  vite@5.0.0: {}
`;
    const deps = pnpmParser.parse({ lockfile });
    expect(depthOf(deps, "npm:vue")).toBe(0);
    expect(depthOf(deps, "npm:vite")).toBe(0);
    expect(depthOf(deps, "npm:@vue/shared")).toBe(1);
  });

  test("strips versions and peer suffixes from keys", () => {
    expect(packageName("vue@3.4.0")).toBe("vue");
    expect(packageName("@vue/shared@3.4.0")).toBe("@vue/shared");
    expect(packageName("react-dom@18.0.0(react@18.0.0)")).toBe("react-dom");
    expect(packageName("@scope/x@1.0.0(a@1)(b@2)")).toBe("@scope/x");
  });
});

describe("yarn — classic and berry", () => {
  test("classic v1 needs package.json for roots", () => {
    const lockfile = `
# yarn lockfile v1

lodash@^4.17.0:
  version "4.17.21"

express@^4.18.0:
  version "4.18.2"
  dependencies:
    body-parser "1.20.1"

body-parser@1.20.1:
  version "1.20.1"
`;
    const manifest = JSON.stringify({ dependencies: { express: "^4.18.0" } });
    const deps = yarnParser.parse({ lockfile, manifest });

    expect(depthOf(deps, "npm:express")).toBe(0);
    expect(depthOf(deps, "npm:body-parser")).toBe(1);
    // Present in the lockfile but not chosen — included, not claimed as direct.
    expect(depthOf(deps, "npm:lodash")).toBe(1);
  });

  test("without a manifest, nothing is claimed to be direct", () => {
    // Claiming every package is a root would flatten depth to zero and destroy
    // the 1/(1+depth) weighting.
    const lockfile = `\nlodash@^4:\n  version "4.17.21"\n`;
    const deps = yarnParser.parse({ lockfile });
    expect(deps.every((dep) => dep.d > 0)).toBe(true);
  });

  test("berry is detected by __metadata and parsed as YAML", () => {
    const lockfile = `
__metadata:
  version: 8
"express@npm:^4.18.0":
  version: 4.18.2
  dependencies:
    body-parser: "npm:1.20.1"
"body-parser@npm:1.20.1":
  version: 1.20.1
`;
    const manifest = JSON.stringify({ dependencies: { express: "^4.18.0" } });
    const deps = yarnParser.parse({ lockfile, manifest });

    expect(depthOf(deps, "npm:express")).toBe(0);
    expect(depthOf(deps, "npm:body-parser")).toBe(1);
  });

  test("descriptor names strip ranges and protocols", () => {
    expect(descriptorName("lodash@^4.17.0")).toBe("lodash");
    expect(descriptorName('"express@npm:^4.18.0"')).toBe("express");
    expect(descriptorName("@babel/core@npm:7.0.0")).toBe("@babel/core");
  });
});

describe("bun — bun.lock", () => {
  test("parses JSONC with trailing commas", () => {
    const lockfile = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "typescript": "5.0.0", }, },
  },
  "packages": {
    "typescript": ["typescript@5.0.0", "", {}, "sha512-x"],
  },
}`;
    const deps = bunParser.parse({ lockfile });
    expect(depthOf(deps, "npm:typescript")).toBe(0);
  });

  test("workspace packages are excluded", () => {
    const lockfile = JSON.stringify({
      workspaces: {
        "": { name: "root", dependencies: { "@me/lib": "workspace:*", zod: "3.0.0" } },
        "packages/lib": { name: "@me/lib" },
      },
      packages: { zod: ["zod@3.0.0", "", {}, "sha512-x"] },
    });
    const deps = bunParser.parse({ lockfile });

    expect(deps.map((dep) => dep.p)).toContain("npm:zod");
    expect(deps.map((dep) => dep.p)).not.toContain("npm:@me/lib");
  });

  test("depth comes from the dependency map in the tuple", () => {
    const lockfile = JSON.stringify({
      workspaces: { "": { name: "r", dependencies: { a: "1" } } },
      packages: {
        a: ["a@1", "", { dependencies: { b: "1" } }, "sha"],
        b: ["b@1", "", { dependencies: { c: "1" } }, "sha"],
        c: ["c@1", "", {}, "sha"],
      },
    });
    const deps = bunParser.parse({ lockfile });
    expect([depthOf(deps, "npm:a"), depthOf(deps, "npm:b"), depthOf(deps, "npm:c")]).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("cargo — Cargo.lock", () => {
  test("roots from Cargo.toml, depth from the package graph", () => {
    const lockfile = `
[[package]]
name = "myapp"
version = "0.1.0"
dependencies = ["serde"]

[[package]]
name = "serde"
version = "1.0.0"
dependencies = ["serde_derive 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)"]

[[package]]
name = "serde_derive"
version = "1.0.0"
`;
    const manifest = `[dependencies]\nserde = "1.0"\n`;
    const deps = cargoParser.parse({ lockfile, manifest });

    expect(depthOf(deps, "cargo:serde")).toBe(0);
    expect(depthOf(deps, "cargo:serde_derive")).toBe(1);
  });

  test("without a manifest, crates nothing depends on are the roots", () => {
    const lockfile = `
[[package]]
name = "myapp"
dependencies = ["serde"]

[[package]]
name = "serde"
`;
    const deps = cargoParser.parse({ lockfile });
    expect(depthOf(deps, "cargo:myapp")).toBe(0);
    expect(depthOf(deps, "cargo:serde")).toBe(1);
  });
});

describe("python — poetry and uv", () => {
  test("poetry: dependencies are a TABLE, roots from pyproject", () => {
    const lockfile = `
[[package]]
name = "requests"
version = "2.31.0"

[package.dependencies]
urllib3 = ">=1.21.1"
certifi = "*"

[[package]]
name = "urllib3"
version = "2.0.0"

[[package]]
name = "certifi"
version = "2023.1.1"
`;
    const manifest = `[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\n`;
    const deps = poetryParser.parse({ lockfile, manifest });

    expect(depthOf(deps, "pypi:requests")).toBe(0);
    expect(depthOf(deps, "pypi:urllib3")).toBe(1);
    // `python` is an interpreter constraint, not a package.
    expect(deps.map((dep) => dep.p)).not.toContain("pypi:python");
  });

  test("uv: dependencies are an ARRAY, roots from the virtual project", () => {
    const lockfile = `
[[package]]
name = "myproject"
version = "0.1.0"
source = { virtual = "." }

[[package.dependencies]]
name = "httpx"

[[package]]
name = "httpx"
version = "0.27.0"

[[package.dependencies]]
name = "httpcore"

[[package]]
name = "httpcore"
version = "1.0.0"
`;
    const deps = uvParser.parse({ lockfile });

    expect(depthOf(deps, "pypi:httpx")).toBe(0);
    expect(depthOf(deps, "pypi:httpcore")).toBe(1);
    // The project itself is not a dependency anyone is paid for.
    expect(deps.map((dep) => dep.p)).not.toContain("pypi:myproject");
  });

  test("requirement names strip extras, markers and specifiers", () => {
    expect(requirementName("requests>=2.0")).toBe("requests");
    expect(requirementName("requests[socks] >= 2.0")).toBe("requests");
    expect(requirementName('django ; python_version < "3.9"')).toBe("django");
  });
});

describe("go — go.sum with go.mod", () => {
  test("`// indirect` in go.mod is the direct/indirect split", () => {
    const lockfile = `
github.com/gin-gonic/gin v1.9.1 h1:abc=
github.com/gin-gonic/gin v1.9.1/go.mod h1:def=
github.com/bytedance/sonic v1.9.1 h1:ghi=
`;
    const manifest = `
module example.com/me

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/bytedance/sonic v1.9.1 // indirect
)
`;
    const deps = goParser.parse({ lockfile, manifest });

    expect(depthOf(deps, "go:github.com/gin-gonic/gin")).toBe(0);
    expect(depthOf(deps, "go:github.com/bytedance/sonic")).toBe(1);
  });

  test("the /go.mod hash line is not a separate module", () => {
    const lockfile = "example.com/x v1.0.0 h1:a=\nexample.com/x v1.0.0/go.mod h1:b=\n";
    const deps = goParser.parse({ lockfile });
    expect(deps.map((dep) => dep.p)).toEqual(["go:example.com/x"]);
  });

  test("a single-line require is handled", () => {
    const deps = goParser.parse({
      lockfile: "example.com/y v1.0.0 h1:a=\n",
      manifest: "module m\nrequire example.com/y v1.0.0\n",
    });
    expect(depthOf(deps, "go:example.com/y")).toBe(0);
  });
});

describe("ruby — Gemfile.lock", () => {
  test("DEPENDENCIES gives roots, indentation gives the graph", () => {
    const lockfile = `GEM
  remote: https://rubygems.org/
  specs:
    rails (7.1.0)
      actionpack (= 7.1.0)
      activesupport (= 7.1.0)
    actionpack (7.1.0)
      rack (>= 2.2.4)
    activesupport (7.1.0)
    rack (3.0.8)

PLATFORMS
  ruby

DEPENDENCIES
  rails

BUNDLED WITH
   2.4.0
`;
    const deps = rubyParser.parse({ lockfile });

    expect(depthOf(deps, "rubygems:rails")).toBe(0);
    expect(depthOf(deps, "rubygems:actionpack")).toBe(1);
    expect(depthOf(deps, "rubygems:rack")).toBe(2);
  });

  test("a `!` on a dependency (git or path source) is not part of the name", () => {
    const lockfile = `GEM
  specs:
    mygem (1.0)

DEPENDENCIES
  mygem!
`;
    const deps = rubyParser.parse({ lockfile });
    expect(depthOf(deps, "rubygems:mygem")).toBe(0);
  });
});

describe("merging", () => {
  test("keeps the shallowest depth per package", () => {
    // Matches canonicalizeDeps on the server, so both ends agree about the
    // depth map that decides money.
    expect(
      mergeShallowest([
        { p: "npm:react", d: 3 },
        { p: "npm:react", d: 0 },
        { p: "cargo:serde", d: 1 },
      ]).toSorted((a, b) => a.p.localeCompare(b.p)),
    ).toEqual([
      { p: "cargo:serde", d: 1 },
      { p: "npm:react", d: 0 },
    ]);
  });

  test("all nine v1 ecosystems from §10.3 have a parser", () => {
    expect(PARSERS.map((parser) => parser.lockfile).toSorted()).toEqual(
      [
        "Cargo.lock",
        "Gemfile.lock",
        "bun.lock",
        "go.sum",
        "package-lock.json",
        "pnpm-lock.yaml",
        "poetry.lock",
        "uv.lock",
        "yarn.lock",
      ].toSorted(),
    );
  });

  test("npm-family parsers are ordered so a stale lockfile loses", () => {
    // A leftover package-lock.json in a pnpm repo must not dilute the live one.
    const npmFamily = PARSERS.filter((parser) => parser.ecosystem === "npm").map(
      (parser) => parser.lockfile,
    );
    expect(npmFamily.indexOf("package-lock.json")).toBe(npmFamily.length - 1);
  });
});

describe("robustness", () => {
  test("no parser throws on empty, truncated or hostile input", () => {
    for (const parser of PARSERS) {
      for (const lockfile of ["", "\n", "{", "[[", "not a lockfile at all", " "]) {
        expect(() => parser.parse({ lockfile })).not.toThrow();
      }
    }
  });

  test("every parser emits lowercase namespaced ids", () => {
    const deps = npmParser.parse({
      lockfile: JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { LoDash: "^4" } }, "node_modules/LoDash": {} },
      }),
    });
    expect(deps.map((dep) => dep.p)).toEqual(["npm:lodash"]);
  });
});
