/**
 * A stand-in for a developer's own Codex status line provider, for `codex-chain.test.ts`.
 *
 * Speaks just enough newline-delimited MCP to be chained: `initialize`, `tools/list` and
 * `resources/read`. `MODE` picks how it misbehaves, since most of what chaining has to get right
 * is what it does when theirs goes wrong.
 */
const URI = "ui://theirs/footer";
const mode = process.env["MODE"] ?? "good";

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function footer(state: unknown): unknown {
  const thread = (state as { thread?: { id?: string } } | undefined)?.thread;
  if (mode === "invalid-tree") return { type: "marquee", children: ["theirs"] };
  return { type: "row", props: { gap: 1 }, children: ["theirs", thread?.id ?? "no-thread"] };
}

function handle(line: string): void {
  const request = JSON.parse(line) as { id?: unknown; method: string; params?: unknown };
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    reply(request.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} });
  } else if (request.method === "tools/list") {
    const entrypoints = mode === "no-footer" ? [] : [{ type: "statusline", resourceUri: URI }];
    reply(request.id, { tools: [{ name: "usage", _meta: { "openai/ui": { entrypoints } } }] });
  } else if (request.method === "resources/read") {
    if (mode === "hang") return;
    const params = request.params as { uri: string; _meta?: Record<string, unknown> };
    const state = params["_meta"]?.["com.openai/codex-statusline-state"];
    reply(request.id, {
      contents: [
        { uri: params.uri, mimeType: "application/json", text: JSON.stringify(footer(state)) },
      ],
    });
    if (mode === "exit-after-read") process.exit(0);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    handle(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
