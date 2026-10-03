package dev.obrigado.jetbrains

/**
 * `@obrigado/surface`, in Kotlin.
 *
 * INVARIANT 13: there is one renderer, and every host serialises from it. This plugin runs
 * `obrigado statusline --json` and draws the parts it is handed; it never fetches, counts or
 * formats an ad. What every host that draws its own UI needs besides that is the shape of one
 * `--json` line, the checks that decide whether a line is complete enough to draw, and the
 * splitting of a configured command into an argv — which is what the TypeScript package is, and
 * what this file is.
 *
 * A JVM host cannot import that package, so this is a copy, and copies drift. The two are held
 * together by `packages/surface/test/vectors.json`: the TypeScript tests assert the vectors
 * describe that implementation, and `VectorsTest` asserts this one gives the same answers.
 * Change a behaviour in one and the other's tests fail until it matches.
 *
 * Where the TypeScript copy leaves something undefined — a span that is not an object — this
 * one is stricter and falls back to the whole copy as one link. The vectors cover the behaviour
 * both define.
 */

/** The four colours a creative may wear. Never red or yellow: those mean error and warning. */
internal val SPAN_COLORS = listOf("cyan", "blue", "green", "magenta")

/** Line-level colour slot; `default` means the host's own foreground. */
internal val LINE_STYLES = listOf("default") + SPAN_COLORS

/** Line-level effect. Nothing louder than italic is offered, so nothing louder is drawn. */
internal val LINE_EFFECTS = listOf("none", "italic")

/** A run of styled text, as the renderer serialises it. */
internal data class SponsoredSpan(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    /** Reverse video in a terminal; a status bar has no such thing and ignores it. */
    val highlight: Boolean = false,
    /** Carried as sent, like the TypeScript copy; nothing here paints it. */
    val color: String? = null,
    /** Part of the single tracking link whose URL is `Sponsored.url`. */
    val link: Boolean = false,
)

/** Who is paying, as they name themselves. */
internal data class SponsoredBrand(
    val name: String,
    /** A `data:image/png;base64,…` URI built server-side from validated bytes, or null. */
    val logo: String?,
    /** The square mark, on the same terms as `logo`. Nothing here draws it yet; it is modelled
     *  so the vectors, which carry it, read the same on both sides. */
    val icon: String? = null,
)

/** One `--json` line from `obrigado statusline`. */
internal data class Sponsored(
    /**
     * The disclosure, drawn before the copy and never styled. Null only when the developer
     * turned it off locally (A34), and then the copy is drawn alone — never behind a word of
     * this plugin's choosing.
     */
    val label: String?,
    /** The plain copy: the accessible fallback, and the form that belongs in a log. */
    val copy: String,
    /** The click redirect, `https://obrigado.dev/c/<token>`. */
    val url: String,
    val spans: List<SponsoredSpan>,
    val style: String,
    val effect: String,
    val brand: SponsoredBrand?,
)

/**
 * One line of `--json` output, or null for anything that is not a complete sponsored line.
 *
 * Copy and URL, or nothing: a creative without its URL is an impression nobody can act on. The
 * label may be absent, and only for the reason A34 gives. Styling is optional on the wire — an
 * older renderer that sends none still renders, as one unstyled link over the whole line.
 */
internal fun parseSponsored(line: String): Sponsored? {
    val fields = (parseJson(line) as? Json.Obj)?.fields ?: return null
    val copy = (fields["copy"] as? Json.Str)?.value ?: return null
    val url = (fields["url"] as? Json.Str)?.value ?: return null
    if (copy.isEmpty() || url.isEmpty()) return null

    val label =
        when (val raw = fields["label"]) {
            null,
            Json.Null -> null
            // Empty is read as off too, so a bare separator is never drawn.
            is Json.Str -> raw.value.ifEmpty { null }
            // A label of the wrong type is a line nobody should draw at all.
            else -> return null
        }

    return Sponsored(
        label = label,
        copy = copy,
        url = url,
        spans = spans(fields["spans"]) ?: listOf(SponsoredSpan(text = copy, link = true)),
        // A slot or effect this copy does not know is drawn as none: a newer renderer's colour
        // degrades to the host's foreground, never to a string the host cannot interpret.
        style = (fields["style"] as? Json.Str)?.value?.takeIf { it in LINE_STYLES } ?: "default",
        effect = (fields["effect"] as? Json.Str)?.value?.takeIf { it in LINE_EFFECTS } ?: "none",
        brand = brand(fields["brand"]),
    )
}

private fun spans(raw: Json?): List<SponsoredSpan>? {
    val items = (raw as? Json.Arr)?.items ?: return null
    if (items.isEmpty()) return null
    return items.map { item ->
        val span = (item as? Json.Obj)?.fields ?: return null
        SponsoredSpan(
            text = (span["text"] as? Json.Str)?.value ?: return null,
            bold = span["bold"] == Json.Bool(true),
            italic = span["italic"] == Json.Bool(true),
            highlight = span["highlight"] == Json.Bool(true),
            color = (span["color"] as? Json.Str)?.value,
            link = span["link"] == Json.Bool(true),
        )
    }
}

/** A brand without a name is not a brand: the alt text for a logo IS the name. */
private fun brand(raw: Json?): SponsoredBrand? {
    val fields = (raw as? Json.Obj)?.fields ?: return null
    val name = (fields["name"] as? Json.Str)?.value ?: return null
    return SponsoredBrand(
        name = name,
        logo = (fields["logo"] as? Json.Str)?.value,
        icon = (fields["icon"] as? Json.Str)?.value,
    )
}

/**
 * A configured command, split the way a shell would split it — quotes and all.
 *
 * Double quotes, single quotes and backslash escapes are honoured; nothing else is interpreted
 * — no variables, no globs, no operators — because this is a command, not a script. A path with
 * a space in it is the case this exists for.
 */
internal fun splitCommand(text: String): List<String> {
    val out = ArrayList<String>()
    val current = StringBuilder()
    var inToken = false
    var quote: Char? = null

    var index = 0
    while (index < text.length) {
        val character = text[index]
        if (quote != null) {
            if (character == quote) {
                quote = null
            } else if (character == '\\' && quote == '"' && index + 1 < text.length) {
                index += 1
                current.append(text[index])
            } else {
                current.append(character)
            }
        } else if (character == '"' || character == '\'') {
            quote = character
            inToken = true
        } else if (character == '\\' && index + 1 < text.length) {
            index += 1
            current.append(text[index])
            inToken = true
        } else if (isJsWhitespace(character)) {
            if (inToken) out += current.toString()
            current.setLength(0)
            inToken = false
        } else {
            current.append(character)
            inToken = true
        }
        index += 1
    }
    if (inToken) out += current.toString()
    return out
}

/**
 * The argv a host spawns to get its line.
 *
 * `obrigado` from PATH is the installed case. An override replaces the executable and its
 * leading arguments and keeps everything after: the host names itself so the impression
 * attributes to it, and asks for `--json` because it draws with its own primitives.
 */
internal fun statuslineArgv(agent: String, override: String?, json: Boolean = true): List<String> {
    val configured = jsTrim(override.orEmpty())
    val base = if (configured.isNotEmpty()) splitCommand(configured) else listOf("obrigado", "statusline")
    return base + listOf("--agent", agent) + (if (json) listOf("--json") else emptyList())
}

/**
 * JavaScript's `\s`, exactly.
 *
 * Not `Char.isWhitespace`: that one splits on the ASCII unit and record separators, which
 * JavaScript does not, and keeps the byte-order mark, which JavaScript splits on. The copy in
 * TypeScript is the definition, so the set is spelled out rather than approximated.
 */
internal fun isJsWhitespace(character: Char): Boolean =
    when (character) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ', ' ',
        ' ', '　', '﻿' -> true
        in ' '..' ' -> true
        else -> false
    }

/** `String.prototype.trim`, which trims the same set. */
internal fun jsTrim(value: String): String = value.trim(::isJsWhitespace)
