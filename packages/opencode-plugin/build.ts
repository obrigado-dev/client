/**
 * Build what OpenCode loads: `dist/tui.js`.
 *
 * This package shipped `src/tui.tsx` and let OpenCode compile it, which works from a local path
 * and never from npm. OpenCode compiles a plugin's Solid JSX with OpenTUI's transform, and that
 * transform skips every file under `node_modules`, which is exactly where an npm install puts
 * this package. The source then loaded as plain TSX and the plugin never registered. Two rules,
 * both learned the same way in another OpenCode plugin:
 *
 * 1. `@opentui/solid/bun-plugin` compiles the JSX. Solid's reactivity is a compile-time
 *    transform; Bun's own JSX evaluates props eagerly, which freezes the view at its startup
 *    values.
 * 2. What the host owns stays external: solid-js, @opentui/solid, @opentui/core and the plugin
 *    API. OpenCode rewrites those imports to its own instances, even from `node_modules`; a
 *    bundled copy has its own renderer, so it loads, registers, and nothing appears.
 *
 * `@obrigado/surface` stays external as well. It is a real dependency, installed beside this
 * package and pinned to an exact version when it is packed.
 */
import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  // Solid's server build has no reactivity. With solid-js external this changes nothing, and it
  // stays as a guard in case anything Solid-adjacent is ever inlined.
  conditions: ["browser"],
  external: [
    "solid-js",
    "@opentui/solid",
    "@opentui/core",
    "@opencode-ai/plugin",
    "@obrigado/surface",
  ],
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
