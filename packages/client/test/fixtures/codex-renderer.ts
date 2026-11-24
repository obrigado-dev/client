/**
 * A stand-in for `obrigado statusline --agent codex --json`, for `codex-provider-process.test.ts`.
 *
 * Appends what it was run with and handed to `RENDER_LOG`, one JSON object per line, then prints
 * a line numbered by how many times it has run, so a test can tell which render it is looking at.
 * `RENDER_MODE=none` prints nothing and exits cleanly, as the renderer does with nothing to show.
 */
import { appendFileSync, readFileSync } from "node:fs";

const log = process.env["RENDER_LOG"] ?? "";
const payload = await Bun.stdin.text();
appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), payload })}\n`);
const count = readFileSync(log, "utf8").trim().split("\n").length;

if (process.env["RENDER_MODE"] !== "none") {
  process.stdout.write(
    `${JSON.stringify({
      label: "oss-sponsor",
      copy: `Acme: render ${count}`,
      url: `https://obrigado.dev/c/token${count}`,
      spans: [
        { text: "Acme", bold: true, color: "cyan", link: true },
        { text: `: render ${count}`, link: true },
      ],
      style: "default",
      effect: "none",
      brand: null,
    })}\n`,
  );
}
