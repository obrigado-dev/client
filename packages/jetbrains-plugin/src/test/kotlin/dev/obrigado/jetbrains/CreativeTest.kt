package dev.obrigado.jetbrains

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CreativeTest {
    private fun ad(
        label: String? = "oss-sponsor",
        copy: String = "Postgres, but you never think about it",
        spans: List<SponsoredSpan> = listOf(SponsoredSpan(text = copy, link = true)),
        effect: String = "none",
    ) =
        Sponsored(
            label = label,
            copy = copy,
            url = "https://obrigado.dev/c/tok",
            spans = spans,
            style = "default",
            effect = effect,
            brand = null,
        )

    @Test
    fun `the label leads the copy in one string`() {
        assertEquals("oss-sponsor · Postgres, but you never think about it", statusText(ad()))
    }

    @Test
    fun `with the disclosure turned off the copy stands alone, behind nothing`() {
        assertEquals("Postgres, but you never think about it", statusText(ad(label = null)))
    }

    @Test
    fun `status text can never start as HTML, whatever the copy says`() {
        assertEquals("< html><b>free</b>", statusText(ad(label = null, copy = "<html><b>free</b>")))
        assertEquals("< HTML>x", statusText(ad(label = null, copy = "<HTML>x")))
        // With the label leading, the text starts with the label and nothing needs breaking.
        assertEquals("oss-sponsor · <html>x", statusText(ad(copy = "<html>x")))
    }

    @Test
    fun `advertiser text in the tooltip is data, not markup`() {
        val hostile = "<img src=https://tracker.example/p.gif> & \"quotes\" 'too'"
        val html = tooltipHtml(ad(copy = hostile))
        assertFalse(html.contains("<img"), html)
        assertTrue(html.contains("&lt;img src=https://tracker.example/p.gif&gt; &amp; &quot;quotes&quot; &#39;too&#39;"), html)
    }

    @Test
    fun `the tooltip carries the label, the runs' emphasis and the footer`() {
        val html =
            tooltipHtml(
                ad(spans = listOf(SponsoredSpan(text = "Postgres", bold = true), SponsoredSpan(text = ", but calm", italic = true)))
            )
        assertEquals(
            "<html><b>oss-sponsor</b><br><b>Postgres</b><i>, but calm</i><br><br><i>$FOOTER</i></html>",
            html,
        )
    }

    @Test
    fun `an italic line italicises every run, and no label means no bold line`() {
        val html = tooltipHtml(ad(label = null, spans = listOf(SponsoredSpan(text = "calm")), effect = "italic"))
        assertEquals("<html><i>calm</i><br><br><i>$FOOTER</i></html>", html)
    }

    @Test
    fun `a click opens https, or plain http to a development stack, and nothing else`() {
        assertTrue(isOpenable("https://obrigado.dev/c/tok"))
        assertTrue(isOpenable("http://localhost:8787/c/tok"))
        assertTrue(isOpenable("http://127.0.0.1:8787/c/tok"))
        assertFalse(isOpenable("http://obrigado.dev/c/tok"))
        assertFalse(isOpenable("file:///etc/passwd"))
        assertFalse(isOpenable("javascript:alert(1)"))
        assertFalse(isOpenable("https://"))
        assertFalse(isOpenable("not a url"))
    }
}
