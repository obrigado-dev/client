/**
 * The install-time targeting questions, and the JSON that answers them honestly.
 *
 * ## Why this exists when `printTargetingOffer` already did
 *
 * The printed offer told a developer that targeting exists and left them to go and read
 * `obrigado privacy` later. Almost nobody does, which made "all of it is off unless you say
 * otherwise" true in the way a buried checkbox is true: nothing was taken, but nothing was
 * decided either. Asking once, at the only moment the developer is already paying attention,
 * is the difference between a default and a choice.
 *
 * ## What it shows, and why it is JSON
 *
 * One block, once, after the config is written: the exact `signals` fragment a render sends.
 * Not a summary of it, the bytes. Same argument `install.sh` makes by being readable, and a
 * project whose whole claim is that it can be audited does not get to describe its own payload
 * in prose.
 *
 * It was printed after every answer, and then twice more — once as the request and once as the
 * file. Both were wrong. Redrawing made the screen read as output rather than a question, and
 * the second copy was the same object under a different heading, since the file holds the
 * `sharing` half of exactly what is shown.
 *
 * ## What it does not do
 *
 * It never runs without a terminal attached, and never turns anything on without an explicit
 * `y`. Both are load-bearing: `install` runs in provisioning scripts and Dockerfiles, where a
 * blocking question is a hang, and consent that can be given by a stray newline is not consent.
 * `--no-input` forces the old printed offer for the terminal-attached script that wants it.
 */
import { createInterface } from "node:readline/promises";

import { API_VERSION } from "@obrigado/shared";
import type { SharingSettings } from "@obrigado/shared";

import { isCiEnvironment } from "../api.ts";
import { OBRIGADO_DIR, sharingSettings } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { peekRetrieval } from "../retrieval.ts";
import { DIMENSIONS, printTargetingOffer, wrapAt } from "./privacy.ts";
import { apiOrigin } from "./shared.ts";

/** Everything off — the answer given by saying nothing, and the shape the wire expects. */
export const NOTHING_SHARED: Readonly<SharingSettings> = {
  packages: false,
  region: false,
  network: false,
  activity: false,
};

/**
 * One line of input, or `null` when the stream ended.
 *
 * Injected rather than read here so the flow is testable without a pty: `runTargetingSetup`
 * is the part with the wording and the ordering in it, which is the part worth asserting on.
 */
export type Ask = (question: string) => Promise<string | null>;

/** Where output goes. `console.log` in the CLI, a collector in the tests. */
export type Say = (line: string) => void;

/**
 * How many package ids the preview prints before it starts counting.
 *
 * A busy install can have hundreds queued and the point of the preview is that it can be read.
 * The elision is stated in the line beneath rather than hidden inside the array, because a
 * truncated list that looks complete is worse than no list.
 */
const PREVIEW_IDS = 6;

/**
 * An explicit yes, or nothing.
 *
 * Anything that is not `y`/`yes` is a no — including a typo, and including an answer this
 * function does not understand. There is no re-ask loop on purpose: the cost of misreading
 * "ys" as no is one `obrigado privacy region on`, and the cost of misreading it as yes is
 * targeting somebody who did not agree to it.
 *
 * `null` means the input stream ended (a closed pipe, or Ctrl-D) and is distinct from a no:
 * the caller abandons the run rather than recording three answers nobody gave.
 */
export function parseAnswer(line: string | null): boolean | null {
  if (line === null) return null;
  const answer = line.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * The `signals` fragment this choice produces, exactly as `collectSignals` builds it.
 *
 * Only the two fields the answers control. The rest of `signals` (the host, the OS, whether a
 * TTY is attached) is not a targeting choice, and printing it here would suggest it were.
 *
 * Stringified rather than hand-assembled so the screen cannot drift from being valid JSON.
 */
export function requestPreview(sharing: SharingSettings, retrieved: readonly string[]): string {
  const signals = {
    sharing,
    ...(sharing.activity ? { retrieved: retrieved.slice(0, PREVIEW_IDS) } : {}),
  };
  const lines = [`  "signals": ${JSON.stringify(signals, null, 2).replaceAll("\n", "\n  ")}`];

  const hidden = retrieved.length - PREVIEW_IDS;
  if (sharing.activity && hidden > 0) {
    lines.push("", `  ${PREVIEW_IDS} of ${retrieved.length} shown.`);
  }
  return lines.join("\n");
}

function preamble(say: Say): void {
  say("\nTargeting: 4 questions, all default no. Nothing is targetable until you say so.");
  say("You earn nothing for saying yes; better targeting just pays your deps more.");
}

/**
 * Ask the three, in the order `obrigado privacy` lists them.
 *
 * Returns `null` when the input ended mid-run — the caller keeps the developer's existing
 * settings rather than writing three defaults over them, because a hang-up is not an answer.
 */
export async function runTargetingSetup(
  ask: Ask,
  retrieved: readonly string[],
  say: Say = console.log,
): Promise<SharingSettings | null> {
  preamble(say);

  // Mutated in place, and asked strictly in order. Questions a person answers are round trips
  // through a terminal; there is nothing here to run in parallel.
  const sharing: SharingSettings = { ...NOTHING_SHARED };

  for (const dimension of DIMENSIONS) {
    say(`\n  ${dimension.label}`);
    for (const line of wrapAt(dimension.what, "    ")) say(line);
    for (const line of wrapAt(dimension.stored, "    ")) say(line);
    if (dimension.key === "activity" && retrieved.length === 0) {
      // Said before the question, not after it: a developer deciding whether to share a list
      // deserves to know the list is currently empty, and why.
      say("    Nothing queued yet; needs the `obrigado read --print-hook` hook.");
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- a person answers one question at a time
    const answer = parseAnswer(await ask(`  Allow ${dimension.label}? [y/N] `));
    if (answer === null) return null;

    sharing[dimension.key] = answer;
  }

  return sharing;
}

/**
 * Whether there is a person here to answer.
 *
 * Three ways to say no, and the CI check is not redundant with the TTY one: a runner that
 * allocates a pty — `docker run -t`, some self-hosted agents — passes `isTTY` with nobody
 * watching, and a build that blocks on an unanswerable question looks like a hung runner
 * rather than a prompt.
 */
export function canAsk(argv: readonly string[]): boolean {
  if (argv.includes("--no-input")) return false;
  if (isCiEnvironment()) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * `runTargetingSetup` against the real terminal.
 *
 * Ctrl-C closes the interface rather than killing the process, and a closed interface aborts
 * the pending question, which the flow reads as "no answer given". That ordering matters: the
 * status line is already installed by the time these questions are asked, and exiting here
 * would leave an agent configured to run a client whose config was never written.
 */
async function askOnTerminal(retrieved: readonly string[]): Promise<SharingSettings | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController();
  rl.on("close", () => closed.abort());
  rl.on("SIGINT", () => rl.close());

  try {
    return await runTargetingSetup(async (question) => {
      try {
        return await rl.question(question, { signal: closed.signal });
      } catch {
        return null;
      }
    }, retrieved);
  } finally {
    rl.close();
  }
}

/** What the questions settled, and whether they were put at all. */
export interface SharingDecision {
  /**
   * Complete, or absent. A config hand-edited down to one key is normalised through
   * `sharingSettings`, so what gets written back names all four: the same object the wire
   * carries. Absent still means nobody was ever asked, which is the distinction being kept.
   */
  readonly sharing: SharingSettings | undefined;
  /** True only when a person answered here and now, not when an old answer was kept. */
  readonly asked: boolean;
  /** The ids the answers were shown against, so the report is the list they agreed to. */
  readonly retrieved: readonly string[];
  /** Where those answers will be sent. */
  readonly origin: string;
}

/**
 * The four targeting answers, asked once and only once.
 *
 * A reinstall does not re-ask. `sharing` present means this developer has already been through
 * the questions, the run where they said no to all four included: that is an answer, not an
 * absence. Asking again on every `obrigado install` would train people to hit enter through it,
 * which is how a consent prompt stops meaning anything.
 *
 * `sharing: undefined` means "no answer to record", which the caller spreads into nothing rather
 * than an all-false object. The distinction survives: `sharingSettings` turns absent into four
 * falses for the wire, while the file goes on saying nobody was asked.
 */
export async function decideSharing(
  existing: ClientConfig | null,
  argv: readonly string[],
): Promise<SharingDecision> {
  const origin = apiOrigin(existing);
  const kept = { sharing: undefined, asked: false, retrieved: [], origin } as const;

  if (existing?.sharing !== undefined) {
    return { ...kept, sharing: sharingSettings(existing) };
  }
  if (!canAsk(argv)) return kept;

  // Real ids, not a sample. The developer is being asked whether to send this list, and a
  // placeholder would be the one dishonest line on a screen whose whole point is that it is not.
  const retrieved = await peekRetrieval();
  const answers = await askOnTerminal(retrieved);
  if (answers === null) {
    console.log("\n\nNo answer, nothing shared. `obrigado privacy` to change.");
    return kept;
  }

  return { sharing: answers, asked: true, retrieved, origin };
}

/**
 * One block, after the write: what is on disk and what leaves the machine.
 *
 * Both, because they are the same object. The file holds the `sharing` half of exactly what is
 * shown; `retrieved` is read fresh each render and never stored, which is the one line of
 * difference and is said rather than left to be inferred.
 *
 * An install nobody could ask gets the printed offer instead, and it lands last for the reason
 * it always did: it is the thing left on screen when the install finishes.
 */
export function reportStored(decision: SharingDecision): void {
  const where = `${OBRIGADO_DIR}/config.json (mode 0600)`;
  console.log(`\nShared install key stored in ${where}.`);

  if (decision.asked && decision.sharing !== undefined) {
    console.log(`Your answers are in the same file, and every render sends them to`);
    console.log(`${decision.origin}/api/${API_VERSION}/session:\n`);
    console.log(requestPreview(decision.sharing, decision.retrieved));
    console.log(
      decision.sharing.activity
        ? '\n  Only "sharing" is stored. "retrieved" is read fresh each render.'
        : '\n  activity off: no "retrieved" key, not an empty one.',
    );
    console.log("");
  }

  console.log("70% of gross revenue goes to the packages your project depends on.");
  if (!decision.asked) printTargetingOffer(decision.sharing);
}
