/**
 * The social profiles a wall entry may link (A29): one website, and one handle per platform.
 *
 * Handles, not URLs. Every profile link is built here from a fixed pattern, so a handle can
 * only ever point at its own platform — `--github` cannot carry a phishing page — and "one
 * account per platform" is the shape of the data (an object keyed by platform) rather than a
 * rule something has to remember to check. Anything that lives somewhere else goes in the one
 * free `url` beside these.
 *
 * Each pattern is a little looser than the platform's own rules, because refusing somebody's
 * real handle is worse than accepting an unusual one. What no pattern may ever be looser than
 * is the set of characters that are inert in a URL: no `/`, `?`, `#`, `%`, `:` or whitespace
 * reaches an href, and a handle has to start with a letter, digit or underscore so `..` cannot
 * walk out of the profile path. Mastodon is the one platform whose host is part of the
 * handle, because the network is federated; its link can reach any server, but only a
 * profile path on it.
 *
 * No zod in this file, like `markup.ts`: the page that renders these links has no business
 * importing the schema library, and the contract builds its validation from the same table.
 */

export type EntityKind = "company" | "individual";

interface Platform {
  /** How the page names the link. */
  readonly label: string;
  /** What a handle may look like, already stripped of a leading `@`. */
  readonly handle: RegExp;
  /** The profile a valid handle points at. */
  readonly profile: (handle: string, kind: EntityKind) => string;
}

/** A DNS name with at least one dot — a Bluesky handle, or a Mastodon server. */
const HOST = String.raw`(?=.{3,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;

/** In display order, which is also the order `obrigado link` lists the flags in. */
export const SOCIAL_PLATFORMS = {
  github: {
    label: "GitHub",
    handle: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u,
    profile: (handle) => `https://github.com/${handle}`,
  },
  gitlab: {
    label: "GitLab",
    handle: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u,
    profile: (handle) => `https://gitlab.com/${handle}`,
  },
  x: {
    label: "X",
    handle: /^[A-Za-z0-9_]{1,15}$/u,
    profile: (handle) => `https://x.com/${handle}`,
  },
  bluesky: {
    label: "Bluesky",
    handle: new RegExp(`^${HOST}$`, "u"),
    profile: (handle) => `https://bsky.app/profile/${handle}`,
  },
  mastodon: {
    label: "Mastodon",
    handle: new RegExp(`^[A-Za-z0-9_]{1,30}@${HOST}$`, "u"),
    profile: (handle) => {
      const [user, host] = handle.split("@");
      return `https://${host}/@${user}`;
    },
  },
  threads: {
    label: "Threads",
    handle: /^[A-Za-z0-9_][A-Za-z0-9._]{0,29}$/u,
    profile: (handle) => `https://www.threads.com/@${handle}`,
  },
  linkedin: {
    label: "LinkedIn",
    handle: /^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/u,
    // A company entry is the company, so its LinkedIn is the company page.
    profile: (handle, kind) =>
      kind === "company"
        ? `https://www.linkedin.com/company/${handle}`
        : `https://www.linkedin.com/in/${handle}`,
  },
  youtube: {
    label: "YouTube",
    handle: /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,29}$/u,
    profile: (handle) => `https://www.youtube.com/@${handle}`,
  },
  instagram: {
    label: "Instagram",
    handle: /^[A-Za-z0-9_][A-Za-z0-9._]{0,29}$/u,
    profile: (handle) => `https://www.instagram.com/${handle}`,
  },
  tiktok: {
    label: "TikTok",
    handle: /^[A-Za-z0-9_][A-Za-z0-9._]{1,23}$/u,
    profile: (handle) => `https://www.tiktok.com/@${handle}`,
  },
  twitch: {
    label: "Twitch",
    handle: /^[A-Za-z0-9_]{4,25}$/u,
    profile: (handle) => `https://www.twitch.tv/${handle}`,
  },
  reddit: {
    label: "Reddit",
    handle: /^[A-Za-z0-9_-]{3,20}$/u,
    profile: (handle) => `https://www.reddit.com/user/${handle}`,
  },
  hackernews: {
    label: "Hacker News",
    handle: /^[A-Za-z0-9_-]{2,15}$/u,
    profile: (handle) => `https://news.ycombinator.com/user?id=${handle}`,
  },
  facebook: {
    label: "Facebook",
    handle: /^[A-Za-z0-9][A-Za-z0-9.]{4,49}$/u,
    profile: (handle) => `https://www.facebook.com/${handle}`,
  },
} as const satisfies Record<string, Platform>;

export type SocialPlatform = keyof typeof SOCIAL_PLATFORMS;

export const SOCIAL_PLATFORM_IDS = Object.keys(SOCIAL_PLATFORMS) as readonly SocialPlatform[];

/** One handle per platform, by construction. `undefined` is allowed because that is what a
 *  parsed optional key is under `exactOptionalPropertyTypes`, and it means the same as absent. */
export type Socials = Partial<Record<SocialPlatform, string | undefined>>;

/** One value per platform — how the contract builds its schema without restating the list. */
export function perPlatform<T>(make: (platform: SocialPlatform) => T): Record<SocialPlatform, T> {
  const entries = SOCIAL_PLATFORM_IDS.map((platform) => [platform, make(platform)] as const);
  return Object.fromEntries(entries) as Record<SocialPlatform, T>;
}

/** Same handles on the same platforms, whatever order the keys were written in. */
export function sameSocials(a: Readonly<Socials>, b: Readonly<Socials>): boolean {
  return SOCIAL_PLATFORM_IDS.every((platform) => a[platform] === b[platform]);
}

export function isSocialPlatform(value: string): value is SocialPlatform {
  return Object.hasOwn(SOCIAL_PLATFORMS, value);
}

/** The profile `handle` points at — read through `Platform`, so every platform takes a kind. */
export function profileUrl(platform: SocialPlatform, handle: string, kind: EntityKind): string {
  const entry: Platform = SOCIAL_PLATFORMS[platform];
  return entry.profile(handle, kind);
}

/** Whether `handle` is exactly a valid handle for `platform` — no trimming, no `@`. */
export function isHandle(platform: SocialPlatform, handle: string): boolean {
  return SOCIAL_PLATFORMS[platform].handle.test(handle);
}

/**
 * What somebody typed, as the handle the wire carries: trimmed, one leading `@` dropped
 * (people write `@ada` and `@ada@hachyderm.io`), or `null` when it is not a handle at all.
 */
export function normalizeHandle(platform: SocialPlatform, raw: string): string | null {
  const trimmed = raw.trim();
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return isHandle(platform, handle) ? handle : null;
}

export interface SocialLink {
  readonly platform: SocialPlatform;
  readonly label: string;
  readonly handle: string;
  readonly href: string;
}

/**
 * The links a stored entry renders, in display order.
 *
 * Takes an untyped record because it reads what a database row holds, and re-checks every
 * handle rather than trusting that the write path did: an unknown platform or a handle that
 * no longer matches its pattern is dropped, never linked.
 */
export function socialLinks(
  socials: Readonly<Record<string, unknown>>,
  kind: EntityKind,
): SocialLink[] {
  return SOCIAL_PLATFORM_IDS.flatMap((platform) => {
    const handle = socials[platform];
    if (typeof handle !== "string" || !isHandle(platform, handle)) return [];
    const { label } = SOCIAL_PLATFORMS[platform];
    return [{ platform, label, handle, href: profileUrl(platform, handle, kind) }];
  });
}
