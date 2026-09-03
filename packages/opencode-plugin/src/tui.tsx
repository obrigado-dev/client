/**
 * Obrigado's OpenCode surface.
 *
 * OpenCode has no `statusLine` setting — no config key names a command, and there is no
 * built-in item list to extend the way Codex has. What it has instead is better than
 * either: a TUI plugin API where a plugin registers Solid components into NAMED SLOTS of
 * the host's own layout. `app_bottom` is persistent and host-owned, which is the property
 * that makes a status line a countable impression and a toast not.
 *
 * Two things follow, and they are what make this shippable where Codex was not:
 *
 *   1. Nothing is patched. The plugin loads because the developer listed it in
 *      `tui.json`, and it draws only inside a slot the host offers. No bundle rewritten,
 *      no launcher replaced, no CSP relaxed.
 *   2. The copy is genuinely CLICKABLE. OpenTUI exposes `a` with an `href`, so the
 *      creative is a real link rather than a URL printed next to some text. Codex could
 *      do neither — it rendered Markdown literally and stripped OSC 8 — and that, not
 *      the absence of a surface, is what disqualified it.
 *
 * Delivery is not reimplemented here. This asks `obrigado statusline --agent opencode
 * --json` for the parts and composes them with OpenTUI's own primitives. Rotation,
 * batching, beacons, dwell and the disclosure all stay in the one renderer Claude Code
 * already drives. A second delivery path is how hosts begin to disagree about what was
 * shown and what was billed.
 */
import { parseSponsored, statuslineArgv } from "@obrigado/surface";
import type { Sponsored, SponsoredSpan } from "@obrigado/surface";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createRoot, createSignal, onCleanup } from "solid-js";

const AGENT = "opencode";

/**
 * How often the line is re-rendered.
 *
 * Matched to the other hosts' cadence rather than to the frame rate: this is a process
 * spawn, and the batch behind it is cached on disk for far longer. Faster would buy
 * nothing and cost a spawn per tick.
 */
const REFRESH_MS = 30_000;

/**
 * How this terminal opens a link, named the way the developer's keyboard does.
 *
 * The modifier is the TERMINAL's, not ours: OpenTUI hands the OSC 8 to the emulator, and
 * every emulator that supports them requires a modifier so ordinary text selection still
 * works. macOS uses Command; elsewhere it is Control.
 *
 * This differs from Claude Code, where a plain click is enough — there the host does its
 * own hit-testing rather than delegating to the terminal. Which is precisely why the hint
 * is written here, next to the surface whose behaviour it describes, instead of being
 * shipped down the wire as part of the creative.
 */
const CLICK_HINT = process.platform === "darwin" ? "⌘ click" : "ctrl click";

/**
 * PROTOTYPE (A20). `OBRIGADO_AD_STYLE=glyph` puts a small animated indicator beside the
 * label, so the "richer line" question can be looked at rather than argued about.
 *
 * Deliberately not the default and deliberately not advertiser-selectable: A20 makes this
 * a HOST preference chosen at install, because motion in peripheral vision is an
 * attention-grab by mechanism and an advertiser must never be able to buy one.
 *
 * Braille rather than a spinner of slashes: it occupies one cell at every frame, so the
 * copy beside it never shifts. A line that jitters is worse than a line that is louder.
 */
/**
 * A mark that changes FORM rather than position.
 *
 * A rotating glyph is a progress spinner — that is what rotation means to anyone who has
 * used a terminal — and the first attempt read exactly that way. A dim pulse fixed it by
 * disappearing, which is its own failure. These four grow and contract in place: there is
 * something to look at, and nothing travelling around a circle.
 */
const GLYPH_FRAMES = ["✳", "✶", "✻", "✽"] as const;

/**
 * Slow, and a pulse rather than a rotation.
 *
 * The first attempt used braille frames and read as a loading spinner, because that IS the
 * universal idiom for one — a rotating glyph beside text says "waiting", not "sponsor". The
 * character is now fixed and only its intensity moves, on a cycle far too slow to track.
 * Nothing changes shape, so peripheral vision has nothing to catch on.
 */
const PULSE_MS = 400;

function glyphEnabled(): boolean {
  return process.env["OBRIGADO_AD_STYLE"] === "glyph";
}

function wordmarkEnabled(): boolean {
  return process.env["OBRIGADO_AD_STYLE"] === "wordmark";
}

/** A spawn that outlives its usefulness is a spawn holding up the UI. */
const RENDER_TIMEOUT_MS = 2_000;

/*
 * The wire shape and its parser come from `@obrigado/surface`, shared with the VS Code
 * extension. The brand on it replaced a `guessBrand()` that read the trailing domain out of
 * the ad copy, because there was no brand on the wire and every seeded creative happened to
 * end with one — which worked on the fixtures and would eventually have rendered the wrong
 * company's name, in a font three lines tall, in somebody's terminal.
 */

/**
 * One run's attributes, in OpenTUI's vocabulary.
 *
 * The palette needs no translation: obrigado's slots are already named colours, and
 * `@opentui/solid` feeds `fg` through `parseColor`. The rest is a direct mapping —
 * except `highlight`, which is REVERSE VIDEO rather than a background colour, because
 * reverse swaps the reader's own colours and so cannot render unreadably against a
 * theme we know nothing about. `inverse` is OpenTUI's name for it.
 *
 * A span's own colour beats the creative's line-level slot; italic is applied if
 * EITHER asks for it, matching how the terminal renderer nests them.
 */
function runStyle(span: SponsoredSpan, ad: Sponsored, hovered = false): Record<string, unknown> {
  const fg = span.color ?? (ad.style === "default" ? undefined : ad.style);
  return {
    ...(fg === undefined ? {} : { fg }),
    ...(span.bold === true ? { bold: true } : {}),
    ...(span.italic === true || ad.effect === "italic" ? { italic: true } : {}),
    ...(span.highlight === true ? { inverse: true } : {}),
    // Underline means "this is a link" and nothing else — applied exactly when the run
    // really is one, never as an advertiser-selectable flourish. OpenTUI does not
    // underline `a` itself, and a link nobody can see is a link nobody clicks.
    ...(span.link === true ? { underline: true } : {}),
    // Hover brightens the link and nothing else.
    //
    // An affordance, not an attention-grab: it fires only when the developer has
    // deliberately pointed at the copy, it never changes the resting state, and it
    // does not touch the advertiser's colour — so it can confirm "this is clickable"
    // without making the ad louder or misreporting which slot was bought (§3).
    ...(span.link === true && hovered ? { bold: true } : {}),
  };
}

/**
 * The CLI, resolved once.
 *
 * `obrigado` on PATH is the installed case; the override exists for running against a
 * source checkout, which is the only way to develop this before the client is published.
 */
function statuslineCommand(): readonly string[] {
  return statuslineArgv(AGENT, process.env["OBRIGADO_STATUSLINE_COMMAND"]);
}

/**
 * The payload the renderer expects on stdin.
 *
 * Deliberately the shape Claude Code sends, because the renderer keys per-session state
 * off `session_id`. Omitting it would collapse every OpenCode window into one shared
 * rotation cursor, so two sessions would consume each other's inventory.
 */
function payloadFor(sessionId: string, cwd: string): string {
  return JSON.stringify({ session_id: sessionId, cwd });
}

/**
 * Every failure returns null, which renders nothing.
 *
 * That is the correct failure for an advertisement: OpenCode looks exactly as it did
 * before the plugin was installed. An error surfaced into the developer's chrome would
 * be a worse outcome than showing no ad.
 */
async function fetchSponsored(sessionId: string, cwd: string): Promise<Sponsored | null> {
  const [command, ...args] = statuslineCommand();
  if (command === undefined) return null;

  let proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  let timedOut = false;
  try {
    proc = Bun.spawn({
      cmd: [command, ...args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(payloadFor(sessionId, cwd));
    await proc.stdin.end();

    // The FIRST line, not the whole stream. The renderer prints its line and then ships
    // beacons before exiting, and waiting for exit meant the render budget and the beacon
    // budget were one budget — a slow network made the host draw nothing for an impression
    // that was already queued. The child keeps running after the line is read; only a child
    // that never produces one is killed.
    const line = await Promise.race([
      firstLine(proc.stdout),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, RENDER_TIMEOUT_MS);
      }),
    ]);
    if (line === null) return null;
    // Label, copy and URL or nothing; styling optional; a brand without a name is not a
    // brand. The rules live in `@obrigado/surface` so this host and VS Code cannot disagree.
    return parseSponsored(line);
  } catch {
    return null;
  } finally {
    // Killed only when it produced nothing in time. A child that answered is still shipping
    // the impression it just rendered, and killing it there would lose that beacon.
    if (timedOut) proc?.kill();
  }
}

/**
 * The first non-empty line of a stream, or null at end of stream.
 *
 * Reads until a newline and then releases the stream without draining it: the child's
 * remaining output is nothing this host needs, and holding the pipe open would keep the
 * child blocked on writes that nobody reads.
 */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read one chunk at a time by definition
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf("\n");
      if (newline === -1) continue;
      const line = buffered.slice(0, newline).trim();
      if (line.length > 0) return line;
      buffered = buffered.slice(newline + 1);
    }
    const rest = buffered.trim();
    return rest.length > 0 ? rest : null;
  } finally {
    reader.cancel().catch(() => null);
  }
}

/**
 * The row itself.
 *
 * Split out because `initialize` should read as wiring rather than markup — and, as it
 * turned out, because it is what makes the hover release. Read inside the slot callback,
 * `hovered()` re-ran the whole callback and rebuilt the row on every pointer change; since
 * OpenTUI skips `out` for a renderable that is already destroyed, the flag could never be
 * cleared and the line stayed emphasised for good. Given its own tracking scope, the read
 * updates props on a row that survives.
 */
function sponsoredRow(
  ad: Sponsored,
  hovered: () => boolean,
  setHovered: (value: boolean) => void,
  frame: () => number,
  startup: () => boolean,
): JSX.Element {
  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      onMouseOver={() => {
        setHovered(true);
      }}
      onMouseOut={() => {
        setHovered(false);
      }}
    >
      {/*
        The wordmark sits ABOVE the labeled line, never instead of it. Whatever the
        presentation, the disclosure is present, unstyled and outside the link (A20).
      */}
      {wordmarkEnabled() && startup() && ad.brand !== null ? (
        <ascii_font text={ad.brand.name} font="tiny" />
      ) : null}
      <text>
        {glyphEnabled() ? `${GLYPH_FRAMES[frame() % GLYPH_FRAMES.length] ?? ""} ` : ""}
        {ad.label} ·{" "}
        {ad.spans.map((span) =>
          span.link === true ? (
            <a href={ad.url} style={runStyle(span, ad, hovered())}>
              {span.text}
            </a>
          ) : (
            <span style={runStyle(span, ad)}>{span.text}</span>
          ),
        )}
        {/*
          Shown only while pointed at, and never part of the link. This is OBRIGADO's
          chrome, not the advertiser's: dimmed, never carrying the creative's palette,
          and outside the `a` so it cannot itself be clicked. An advertiser must not be
          able to buy this text or make it louder — it answers "how do I open this?"
          and nothing else.
        */}
        {hovered() ? <span style={{ dim: true }}> ({CLICK_HINT})</span> : null}
      </text>
    </box>
  );
}

function initialize(api: TuiPluginApi, disposeRoot: () => void): void {
  const [sponsored, setSponsored] = createSignal<Sponsored | null>(null);
  // One flag for the whole line, not one per run.
  //
  // Partly because consecutive link spans are a single link with a single URL — the
  // terminal renderer wraps them in one OSC 8 for that reason — and partly because
  // OpenTUI puts mouse events on Renderables, not on inline text nodes, so the row's
  // box is the only thing that can observe the pointer. The row is the hit area; only
  // the clickable part of it responds, and the `sponsored` label never lights up.
  const [hovered, setHovered] = createSignal(false);
  // Prototype only, and only ticking when asked for: an idle timer redrawing a status row
  // ten times a second is a cost every developer pays for a mode most will not choose.
  const [frame, setFrame] = createSignal(0);
  const glyphTimer = glyphEnabled()
    ? setInterval(() => {
        setFrame((value) => value + 1);
      }, PULSE_MS)
    : undefined;

  /**
   * The wordmark stands until the first rotation, not for a fixed span.
   *
   * Tied to the event it is actually about: it introduces the session's first sponsor and
   * steps aside the moment a second one arrives. A timer would have been a guess at how
   * long that takes — too short for a long name, and still up after the ad beneath it
   * changed, which would caption the wrong advertiser.
   */
  const [startup, setStartup] = createSignal(wordmarkEnabled());
  let firstCopy: string | null = null;
  let disposed = false;

  const refresh = (): void => {
    // The home route has no session, and its rotation is genuinely separate from any
    // conversation's — so it gets its own key rather than borrowing the last one's.
    //
    // Read defensively rather than narrowing on `name === "session"`: the route union
    // ends in an open `{ name: string; params?: … }`, so a plugin cannot actually
    // discriminate on the name, and a host that adds a route must not break this.
    const route = api.route.current;
    const raw = "params" in route ? route.params?.["sessionID"] : undefined;
    const sessionId = typeof raw === "string" && raw.length > 0 ? raw : "opencode-home";
    void (async () => {
      const next = await fetchSponsored(sessionId, process.cwd());
      // A refresh that lands after teardown must not touch a disposed root.
      if (disposed) return;
      if (next !== null) {
        // Identity is the COPY: every impression carries its own signed URL, so comparing
        // those would retire the wordmark on the first refresh of the same creative.
        if (firstCopy === null) firstCopy = next.copy;
        else if (next.copy !== firstCopy) setStartup(false);
      }
      // Drop any hover FIRST, because this assignment tears the row down and builds a
      // new one. OpenTUI only delivers `out` to a renderable that is still alive —
      // `processMouseEvent` skips it once `isDestroyed` — so a pointer resting on the
      // line when a creative rotates would leave the flag set with nothing able to
      // clear it, and the replacement row would render emphasised forever.
      setHovered(false);
      setSponsored(next);
    })();
  };

  refresh();
  const timer = setInterval(refresh, REFRESH_MS);

  onCleanup(() => {
    disposed = true;
    // A stale hover would otherwise survive into the next creative, leaving a line
    // that renders as if the mouse were still on it.
    setHovered(false);
    clearInterval(timer);
    if (glyphTimer !== undefined) clearInterval(glyphTimer);

    disposeRoot();
  });

  api.slots.register({
    // Late, so the host's own operational readout keeps its position. We are a guest in
    // this layout, and the developer's model and directory are not inventory to displace.
    order: 90,
    slots: {
      app_bottom() {
        const ad = sponsored();
        return ad === null ? null : sponsoredRow(ad, hovered, setHovered, frame, startup);
      },
    },
  });
}

const plugin: TuiPluginModule = {
  id: "obrigado",
  tui: (api) => {
    createRoot((disposeRoot) => {
      initialize(api, disposeRoot);
    });
    return Promise.resolve();
  },
};

export default plugin;
