/**
 * The wall's social links (A29).
 *
 * The property that matters is the one a handle must never break: whatever somebody types,
 * the link that comes out points at a profile on that platform and nowhere else. The rest —
 * which handles each platform accepts — is pinned loosely on purpose, because refusing a real
 * handle is the worse mistake.
 */
import { describe, expect, test } from "bun:test";

import {
  isHandle,
  normalizeHandle,
  profileUrl,
  SOCIAL_PLATFORM_IDS,
  sameSocials,
  socialLinks,
} from "../src/socials.ts";

describe("handles", () => {
  test("ordinary handles pass on every platform that allows them", () => {
    expect(isHandle("github", "ada-lovelace")).toBe(true);
    expect(isHandle("gitlab", "ada.lovelace")).toBe(true);
    expect(isHandle("x", "ada_l")).toBe(true);
    expect(isHandle("bluesky", "ada.bsky.social")).toBe(true);
    expect(isHandle("mastodon", "ada@hachyderm.io")).toBe(true);
    expect(isHandle("threads", "ada.lovelace")).toBe(true);
    expect(isHandle("linkedin", "ada-lovelace-1815")).toBe(true);
    expect(isHandle("youtube", "AdaCodes")).toBe(true);
    expect(isHandle("instagram", "ada.codes")).toBe(true);
    expect(isHandle("tiktok", "ada.codes")).toBe(true);
    expect(isHandle("twitch", "ada_streams")).toBe(true);
    expect(isHandle("reddit", "ada-l")).toBe(true);
    expect(isHandle("hackernews", "adal")).toBe(true);
    expect(isHandle("facebook", "ada.lovelace")).toBe(true);
  });

  test("nothing that could change where a link goes is a handle, anywhere", () => {
    const hostile = [
      "",
      "ada/../../evil",
      "ada?next=https://evil.example",
      "ada#frag",
      "ada%2Fevil",
      "ada lovelace",
      "https://evil.example",
      "javascript:alert(1)",
      "..",
      ".",
      "ada\nevil",
    ];
    for (const platform of SOCIAL_PLATFORM_IDS) {
      for (const handle of hostile) {
        expect(isHandle(platform, handle)).toBe(false);
      }
    }
  });

  test("a leading @ is what people type, and is dropped", () => {
    expect(normalizeHandle("x", "@ada_l")).toBe("ada_l");
    expect(normalizeHandle("mastodon", "@ada@hachyderm.io")).toBe("ada@hachyderm.io");
    expect(normalizeHandle("github", "  ada  ")).toBe("ada");
    expect(normalizeHandle("github", "@@ada")).toBeNull();
    expect(normalizeHandle("x", "https://x.com/ada")).toBeNull();
  });
});

describe("profile links", () => {
  test("each platform builds its own profile URL", () => {
    expect(profileUrl("github", "ada", "individual")).toBe("https://github.com/ada");
    expect(profileUrl("bluesky", "ada.bsky.social", "individual")).toBe(
      "https://bsky.app/profile/ada.bsky.social",
    );
    expect(profileUrl("mastodon", "ada@hachyderm.io", "individual")).toBe(
      "https://hachyderm.io/@ada",
    );
    expect(profileUrl("hackernews", "adal", "individual")).toBe(
      "https://news.ycombinator.com/user?id=adal",
    );
  });

  test("a company's LinkedIn is its company page; a person's is their profile", () => {
    expect(profileUrl("linkedin", "acme", "company")).toBe("https://www.linkedin.com/company/acme");
    expect(profileUrl("linkedin", "ada-l", "individual")).toBe("https://www.linkedin.com/in/ada-l");
  });

  test("every link a valid handle produces is https", () => {
    for (const platform of SOCIAL_PLATFORM_IDS) {
      const handle = platform === "mastodon" ? "ada@example.social" : "ada_lovelace";
      if (!isHandle(platform, handle)) continue;
      expect(profileUrl(platform, handle, "individual")).toStartWith("https://");
    }
  });
});

describe("sameSocials", () => {
  /* The confirm path decides "changed, back to review" with this, so key order must not count
     and a removed handle must. */
  test("ignores key order and notices an added, removed or edited handle", () => {
    expect(sameSocials({ github: "ada", x: "ada_l" }, { x: "ada_l", github: "ada" })).toBe(true);
    expect(sameSocials({}, {})).toBe(true);
    expect(sameSocials({ github: "ada" }, { github: "ada", x: "ada_l" })).toBe(false);
    expect(sameSocials({ github: "ada" }, {})).toBe(false);
    expect(sameSocials({ github: "ada" }, { github: "grace" })).toBe(false);
  });
});

describe("socialLinks", () => {
  test("renders stored handles in display order", () => {
    const links = socialLinks({ x: "ada_l", github: "ada" }, "individual");

    expect(links.map((link) => link.label)).toEqual(["GitHub", "X"]);
    expect(links[0]?.href).toBe("https://github.com/ada");
  });

  test("drops what the write path should never have stored, rather than linking it", () => {
    const links = socialLinks(
      { github: "ada/../evil", myspace: "tom", x: 42, bluesky: "ada.bsky.social" },
      "individual",
    );

    expect(links.map((link) => link.platform)).toEqual(["bluesky"]);
  });
});
