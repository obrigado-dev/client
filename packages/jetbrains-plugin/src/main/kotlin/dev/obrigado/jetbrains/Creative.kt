package dev.obrigado.jetbrains

import java.net.URI
import java.net.URISyntaxException

/**
 * Everything the widget draws, with none of the IDE in it.
 *
 * Two renderings of the same creative — status bar text and a hover tooltip — each into a target
 * with its own injection hazard. The rule they share: advertiser text is DATA in both. It becomes
 * escaped HTML or broken-up plain text, and never a construct Swing will interpret.
 */

/** Said once, in the tooltip. */
internal const val FOOTER = "70% of revenue funds open source maintainers."

/**
 * Status bar text: label, then copy — one string, in that order.
 *
 * One string and not two widgets. Two adjacent widgets would let another plugin's widget land
 * BETWEEN the label and the ad it labels, and §3 wants no state in which the advertisement is
 * visible and the disclosure is not.
 */
internal fun statusText(ad: Sponsored): String =
    // No label means the developer turned the disclosure off (A34); the copy stands alone rather
    // than behind a separator with nothing before it.
    breakHtmlPrefix(if (ad.label == null) ad.copy else "${ad.label} · ${ad.copy}")

/**
 * Swing renders any text that starts with `<html>` as HTML, so a line may never start with it.
 *
 * The label is ours and always leads, so this only bites when the developer has turned it off
 * and the copy leads instead. Breaking the token is enough — the text stays readable, which
 * matters because this runs on copy nobody reviewed for this hazard. It is the Swing twin of the
 * VS Code extension refusing `$(` in status bar text.
 */
internal fun breakHtmlPrefix(value: String): String =
    if (value.startsWith("<html>", ignoreCase = true)) "< ${value.substring(1)}" else value

/**
 * The tooltip, which is the only rich surface here that costs no click.
 *
 * HTML because Swing tooltips speak it: the label in bold, the copy with the emphasis its runs
 * carry, and the footer. Colour is not carried — the tooltip's background is the theme's, not
 * ours — and neither is the brand's logo, which Swing's HTML cannot draw from a `data:` URI and
 * which must never be fetched from anywhere else: a remote image in a tooltip hands the
 * advertiser an IP address and an activity signal nobody sold them.
 */
internal fun tooltipHtml(ad: Sponsored): String =
    buildString {
        append("<html>")
        if (ad.label != null) append("<b>").append(escapeHtml(ad.label)).append("</b><br>")
        ad.spans.forEach { append(emphasise(it, ad)) }
        append("<br><br><i>").append(escapeHtml(FOOTER)).append("</i>")
        append("</html>")
    }

/** Every character HTML could read as markup, as an entity. Ampersand first, or it escapes the escapes. */
internal fun escapeHtml(value: String): String =
    value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;")

/** A run's emphasis: the subset of the terminal's styling that a tooltip can carry. */
private fun emphasise(span: SponsoredSpan, ad: Sponsored): String {
    val italic = span.italic || ad.effect == "italic"
    val text = escapeHtml(span.text)
    return (if (span.bold) "<b>" else "") + (if (italic) "<i>" else "") + text +
        (if (italic) "</i>" else "") + (if (span.bold) "</b>" else "")
}

/**
 * Whether a click may open this URL.
 *
 * The renderer hands over its signed `/c/<token>` redirect — the one that records the click and
 * sanitises where it lands — and that is `https`. Plain `http` is allowed only to a loopback host,
 * which is what a development stack serves. Anything else, `file:` and `javascript:` included,
 * is not something a status bar click should ever hand to the system.
 */
internal fun isOpenable(url: String): Boolean {
    val uri =
        try {
            URI(url)
        } catch (_: URISyntaxException) {
            return false
        }
    val host = uri.host ?: return false
    return when (uri.scheme?.lowercase()) {
        "https" -> true
        "http" -> host == "localhost" || host == "127.0.0.1" || host == "[::1]"
        else -> false
    }
}
