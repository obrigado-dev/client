import { expect, test } from "bun:test";

import { MATCHES, providerForUrl } from "../src/providers.ts";

test("matches exact providers, never a lookalike domain or insecure origin", () => {
  expect(MATCHES).toHaveLength(4);
  expect(providerForUrl("https://chatgpt.com/c/private-thread")?.id).toBe("chatgpt");
  expect(providerForUrl("https://claude.ai/chat/private-thread")?.id).toBe("claude");
  expect(providerForUrl("https://chat.deepseek.com/a/chat/private-thread")?.id).toBe("deepseek");
  expect(providerForUrl("https://replit.com/@someone/private-project")?.id).toBe("replit");
  expect(providerForUrl("https://chatgpt.com.evil.test/")).toBeNull();
  expect(providerForUrl("http://chatgpt.com/")).toBeNull();
  expect(providerForUrl("https://example.com/")).toBeNull();
});
