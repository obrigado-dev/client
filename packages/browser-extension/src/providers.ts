/** Local adapters only. This table and the selected provider never leave the extension. */
const PROVIDERS = [
  {
    id: "claude",
    name: "Claude",
    host: "claude.ai",
    composer: '[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]',
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    host: "chatgpt.com",
    composer: '#prompt-textarea, textarea[data-testid="prompt-textarea"]',
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    host: "chat.deepseek.com",
    composer: 'textarea#chat-input, textarea[placeholder*="DeepSeek" i]',
  },
  {
    id: "replit",
    name: "Replit",
    host: "replit.com",
    composer:
      '[data-cy="agent-chat-textarea"], [data-testid="chat-input"], textarea[placeholder*="Agent" i], textarea[placeholder*="change" i]',
  },
] as const;

export const MATCHES = PROVIDERS.map((provider) => `https://${provider.host}/*`);

export function providerForUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return PROVIDERS.find((provider) => provider.host === parsed.hostname) ?? null;
  } catch {
    return null;
  }
}

export function findComposer(root: Document, url: string): HTMLElement | null {
  const provider = providerForUrl(url);
  if (provider === null) return null;
  const candidates = root.querySelectorAll<HTMLElement>(provider.composer);
  for (const candidate of candidates) {
    if (candidate.getClientRects().length > 0 && candidate.closest('[aria-hidden="true"]') === null)
      return candidate;
  }
  return null;
}
