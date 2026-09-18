/**
 * GitHub linking on the wire (A31).
 *
 * The same contract as email linking in `api.ts`: a person partway through a flow needs to know
 * which thing went wrong, so a failure carries the server's error code rather than collapsing to
 * null.
 */
import {
  EmailUnlinkResponseSchema,
  GitHubLinkPollResponseSchema,
  GitHubLinkStartResponseSchema,
} from "@obrigado/shared";
import type {
  EmailUnlinkResponse,
  GitHubLinkPollResponse,
  GitHubLinkStartRequest,
  GitHubLinkStartResponse,
} from "@obrigado/shared";

import { parsedOrNull, postLink } from "./api.ts";
import type { LinkResult, StatsOptions } from "./api.ts";

export function startGitHubLink(
  options: StatsOptions,
  request: GitHubLinkStartRequest,
): Promise<LinkResult<GitHubLinkStartResponse>> {
  return postLink(options, "github/start", request, (json) =>
    parsedOrNull(GitHubLinkStartResponseSchema.safeParse(json)),
  );
}

export function pollGitHubLink(
  options: StatsOptions,
  flow: string,
): Promise<LinkResult<GitHubLinkPollResponse>> {
  return postLink(options, "github/poll", { flow }, (json) =>
    parsedOrNull(GitHubLinkPollResponseSchema.safeParse(json)),
  );
}

export function unlinkGitHub(
  options: StatsOptions,
  login: string,
): Promise<LinkResult<EmailUnlinkResponse>> {
  return postLink(options, "github/unlink", { login }, (json) =>
    parsedOrNull(EmailUnlinkResponseSchema.safeParse(json)),
  );
}
