/**
 * The wall's half of the wire contract (A24, A29, A31): linking an email or a GitHub account to
 * an install, so a developer can appear on `/obrigado`.
 *
 * Split from `contract.ts` for length, not for a boundary. Everything here is still the one
 * contract both ends import, re-exported from the package root, and the same rules hold: an
 * unknown key is stripped rather than refused, and nothing is tightened once it has shipped.
 */
import { z } from "zod";

import { hasControlCharacters } from "./markup.ts";
import { isHandle, perPlatform, SOCIAL_PLATFORMS } from "./socials.ts";

// ─────────────── POST /api/v1/link (email linking, feature-flagged) ───────────────

/**
 * An email a developer chooses to attach to this install.
 *
 * This is the ONE exception to "the developer side has no identity", and it is
 * opt-in twice: verifying proves control of the inbox, and `consent_listing` is
 * a separate explicit choice because being published is a different act than
 * being verified. The server refuses the whole feature unless its flag is on,
 * so a client talking to a server that has not launched it gets a clean
 * `feature_disabled` error rather than a mystery 404.
 */
export const LinkEmail = z.email().max(254);

/** Six digits, typed from an email. Entropy comes from the attempt cap and TTL
 *  server-side, not from the code itself. */
export const LinkCode = z.string().regex(/^\d{6}$/u);

/**
 * One handle per platform, keyed by platform — so "one account per platform" is the shape of
 * the object, not a rule. Checked against the same patterns the page renders with
 * (`socials.ts`), so nothing reaches the database that the page would then refuse to link. A
 * key this version does not know is stripped rather than refused, like every other object on
 * the wire: a newer CLI offering a platform the server has not shipped loses that one link,
 * not the whole request.
 */
const SocialHandlesSchema = z.object(
  perPlatform((platform) =>
    z
      .string()
      .refine((handle) => isHandle(platform, handle), {
        message: `not a valid ${SOCIAL_PLATFORMS[platform].label} handle`,
      })
      .optional(),
  ),
);

/**
 * A display name for a public page. Control characters rejected for the same reason as creative
 * copy: this string is published.
 */
const ListingDisplayNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((name) => !hasControlCharacters(name), {
    message: "display name must not contain control or bidirectional characters",
  });

/**
 * One website. http(s) enforced because this becomes an `href` on a public page — `z.url()`
 * alone would accept `javascript:`.
 */
const ListingUrlSchema = z
  .url()
  .max(200)
  .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    message: "url must be http(s)",
  });

export const EmailLinkRequestSchema = z.object({
  email: LinkEmail,
  /**
   * Required, never defaulted. A default here would mean the CLI decided
   * whether a person gets published; the person decides.
   */
  consent_listing: z.boolean(),
  /** Individuals only (freemail domains). */
  display_name: ListingDisplayNameSchema.optional(),
  /**
   * One website, for either kind — for a company, the one link beside the domain it is
   * already listed under (A29).
   */
  url: ListingUrlSchema.optional(),
  /** Social handles, for either kind (A29). */
  socials: SocialHandlesSchema.optional(),
});
export type EmailLinkRequest = z.infer<typeof EmailLinkRequestSchema>;

export const EmailLinkCodeResponseSchema = z.object({
  status: z.literal("code_sent"),
  entity_kind: z.enum(["company", "individual"]),
  /**
   * The exact sentence that will be published if the code is confirmed —
   * authored server-side so the CLI shows the truth rather than its own
   * paraphrase of it.
   */
  publishes: z.string().max(400),
  expires_in_s: z.int().positive(),
});
export type EmailLinkCodeResponse = z.infer<typeof EmailLinkCodeResponseSchema>;

export const EmailLinkConfirmRequestSchema = z.object({
  email: LinkEmail,
  code: LinkCode,
});
export type EmailLinkConfirmRequest = z.infer<typeof EmailLinkConfirmRequestSchema>;

export const LinkedEmailWireSchema = z.object({
  email: z.string(),
  entity_kind: z.enum(["company", "individual"]),
  verified: z.boolean(),
  /** True when this email's entry is publicly visible right now. */
  listed: z.boolean(),
  /** Individuals are reviewed before publication, like every ad creative. */
  pending_review: z.boolean(),
  /** Whether this install's impressions have qualified the entry this period. */
  qualified_this_period: z.boolean(),
});
export type LinkedEmailWire = z.infer<typeof LinkedEmailWireSchema>;

export const EmailLinkConfirmResponseSchema = z.object({
  linked: z.boolean(),
  entry: LinkedEmailWireSchema.optional(),
});
export type EmailLinkConfirmResponse = z.infer<typeof EmailLinkConfirmResponseSchema>;

/** A GitHub account as `obrigado link` reports it (A31). The login is GitHub's, not typed. */
export const LinkedGitHubWireSchema = z.object({
  login: z.string(),
  verified: z.boolean(),
  /** True when the entry is publicly visible right now. The login shows without review. */
  listed: z.boolean(),
  /** A display name, website or other handles waiting in review. The login is already live. */
  pending_review: z.boolean(),
  qualified_this_period: z.boolean(),
});
export type LinkedGitHubWire = z.infer<typeof LinkedGitHubWireSchema>;

export const EmailLinkStatusResponseSchema = z.object({
  /** `YYYY-MM-01`, the period qualification is being reported against. */
  period: z.string(),
  emails: z.array(LinkedEmailWireSchema),
  /** Defaulted, so this client still reads a server that predates GitHub linking. */
  github: z.array(LinkedGitHubWireSchema).default([]),
});
export type EmailLinkStatusResponse = z.infer<typeof EmailLinkStatusResponseSchema>;

export const EmailUnlinkRequestSchema = z.object({ email: LinkEmail });
export type EmailUnlinkRequest = z.infer<typeof EmailUnlinkRequestSchema>;

export const EmailUnlinkResponseSchema = z.object({ unlinked: z.boolean() });
export type EmailUnlinkResponse = z.infer<typeof EmailUnlinkResponseSchema>;

// ─────────────── POST /api/v1/link/github/* (A31, feature-flagged) ───────────────

/**
 * Link a GitHub account through GitHub's device flow.
 *
 * The same listing a personal email carries, minus the email: GitHub proves the account, and
 * the account is keyed by GitHub's numeric id, so a renamed login is the same entry. No scope
 * is requested, which is the whole of what the server can learn — the public profile.
 */
export const GitHubLinkStartRequestSchema = z.object({
  /** Required, never defaulted, for the same reason as `EmailLinkRequestSchema`'s. */
  consent_listing: z.boolean(),
  /** Reviewed before it shows. The login itself needs no review: GitHub proved it. */
  display_name: ListingDisplayNameSchema.optional(),
  url: ListingUrlSchema.optional(),
  /** Other platforms' handles. A `github` key here is ignored: the verified login is the one. */
  socials: SocialHandlesSchema.optional(),
});
export type GitHubLinkStartRequest = z.infer<typeof GitHubLinkStartRequestSchema>;

/** 256 random bits, base64url. The server stores only its sha256. */
export const GitHubFlowToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const GitHubLinkStartResponseSchema = z.object({
  status: z.literal("authorize"),
  /** What the CLI polls with. Not GitHub's device code, which never leaves the server. */
  flow: GitHubFlowToken,
  /** Typed by the person at `verification_uri`. */
  user_code: z.string().min(1).max(16),
  verification_uri: z.url(),
  expires_in_s: z.int().positive(),
  interval_s: z.int().positive(),
  /** The server's sentence, printed verbatim, as for email. */
  publishes: z.string().max(400),
});
export type GitHubLinkStartResponse = z.infer<typeof GitHubLinkStartResponseSchema>;

export const GitHubLinkPollRequestSchema = z.object({ flow: GitHubFlowToken });
export type GitHubLinkPollRequest = z.infer<typeof GitHubLinkPollRequestSchema>;

/**
 * The session an approved GitHub link signs this install in with (A33).
 *
 * Handed over once, in the poll that finishes the link; the server keeps only its sha256. The
 * CLI stores it for a later feature to present as `Authorization: Bearer`, and sends it nowhere
 * today.
 */
export const DeveloperSessionWireSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u),
  expires_at: z.iso.datetime({ offset: true }),
});
export type DeveloperSessionWire = z.infer<typeof DeveloperSessionWireSchema>;

export const GitHubLinkPollResponseSchema = z.discriminatedUnion("status", [
  /** Not approved yet. `interval_s` may grow: GitHub asks callers to slow down, and so do we. */
  z.object({ status: z.literal("pending"), interval_s: z.int().positive() }),
  z.object({
    status: z.literal("linked"),
    entry: LinkedGitHubWireSchema,
    /** Optional, so this client still reads a server from before developers signed in. */
    session: DeveloperSessionWireSchema.optional(),
  }),
  /** The person pressed Cancel on GitHub. */
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
]);
export type GitHubLinkPollResponse = z.infer<typeof GitHubLinkPollResponseSchema>;

export const GitHubUnlinkRequestSchema = z.object({ login: z.string().min(1).max(39) });
export type GitHubUnlinkRequest = z.infer<typeof GitHubUnlinkRequestSchema>;
