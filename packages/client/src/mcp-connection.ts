/**
 * One stdio MCP server this client started, and the requests it has not answered yet.
 *
 * The client half of the newline-delimited JSON-RPC that `codex-provider.ts` speaks the server
 * half of, and only as much of it as chaining a status line provider needs (`codex-chain.ts`):
 * a request with a time limit, a notification, and an end. Every request settles exactly once:
 * with the server's result, or with an error when it refuses, runs over its time, or stops.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One running server. */
export class McpConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";
  closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline !== -1) {
        this.#receive(this.#buffer.slice(0, newline));
        this.#buffer = this.#buffer.slice(newline + 1);
        newline = this.#buffer.indexOf("\n");
      }
    });
    // Read and dropped: a server that fills an unread stderr pipe stops.
    child.stderr.resume();
    const end = (): void => {
      this.close();
    };
    child.on("error", end);
    child.on("close", end);
    child.stdin.on("error", end);
  }

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message["id"] !== "number") return;
    const waiting = this.#pending.get(message["id"]);
    if (waiting === undefined) return;
    this.#pending.delete(message["id"]);
    clearTimeout(waiting.timer);
    if ("error" in message) waiting.reject(new Error("the chained provider refused the request"));
    else waiting.resolve(message["result"]);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("the chained provider is not running"));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("the chained provider did not answer in time"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    if (!this.closed) this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.#pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("the chained provider stopped"));
    }
    this.#pending.clear();
    this.#child.kill();
  }
}
