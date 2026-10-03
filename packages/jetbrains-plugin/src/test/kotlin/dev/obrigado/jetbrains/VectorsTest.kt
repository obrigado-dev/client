package dev.obrigado.jetbrains

import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * The Kotlin copy of `@obrigado/surface`, held to the vectors the TypeScript one is held to.
 *
 * `packages/surface/test/vectors.json` is written by nobody's hand but the TypeScript
 * implementation's: its own tests fail if a vector stops describing it. So a failure here means
 * this copy has drifted from the one every other host runs, not that the vectors are wrong.
 */
class VectorsTest {
    private val vectors: Map<String, Json> by lazy {
        val path = System.getProperty("obrigado.vectors") ?: error("obrigado.vectors is unset: run this through Gradle")
        (parseJson(File(path).readText()) as Json.Obj).fields
    }

    @TestFactory
    fun splitCommand(): List<DynamicTest> =
        cases("splitCommand").map { case ->
            val input = case.string("input")
            DynamicTest.dynamicTest("splitCommand(${jsonString(input)})") {
                assertEquals(case.strings("argv"), splitCommand(input))
            }
        }

    @TestFactory
    fun statuslineArgv(): List<DynamicTest> =
        cases("statuslineArgv").map { case ->
            val override = (case["override"] as? Json.Str)?.value
            val json = (case["json"] as? Json.Bool)?.value ?: true
            DynamicTest.dynamicTest("statuslineArgv with override ${override?.let(::jsonString)}") {
                assertEquals(case.strings("argv"), statuslineArgv(case.string("agent"), override, json))
            }
        }

    @TestFactory
    fun parseSponsored(): List<DynamicTest> =
        cases("parseSponsored").map { case ->
            val line = case.string("line")
            DynamicTest.dynamicTest("parseSponsored(${jsonString(line)})") {
                assertEquals(expected(case["sponsored"]), parseSponsored(line))
            }
        }

    private fun cases(name: String): List<Map<String, Json>> =
        (vectors.getValue(name) as Json.Arr).items.map { (it as Json.Obj).fields }

    /**
     * What the TypeScript returned, as the Kotlin types, with absent optional fields at their
     * defaults. A field this copy does not model fails loudly rather than being skipped: that is
     * the TypeScript growing a part of the line the plugin would silently not know about.
     */
    private fun expected(value: Json?): Sponsored? {
        val fields = (value as? Json.Obj)?.fields ?: return null
        assertKnown(fields.keys, setOf("label", "copy", "url", "spans", "style", "effect", "brand"))
        return Sponsored(
            label = (fields["label"] as? Json.Str)?.value,
            copy = fields.string("copy"),
            url = fields.string("url"),
            spans =
                (fields.getValue("spans") as Json.Arr).items.map { item ->
                    val span = (item as Json.Obj).fields
                    assertKnown(span.keys, setOf("text", "bold", "italic", "highlight", "color", "link"))
                    SponsoredSpan(
                        text = span.string("text"),
                        bold = span["bold"] == Json.Bool(true),
                        italic = span["italic"] == Json.Bool(true),
                        highlight = span["highlight"] == Json.Bool(true),
                        color = (span["color"] as? Json.Str)?.value,
                        link = span["link"] == Json.Bool(true),
                    )
                },
            style = fields.string("style"),
            effect = fields.string("effect"),
            brand =
                (fields["brand"] as? Json.Obj)?.fields?.let {
                    SponsoredBrand(
                        name = it.string("name"),
                        logo = (it["logo"] as? Json.Str)?.value,
                        icon = (it["icon"] as? Json.Str)?.value,
                    )
                },
        )
    }

    private fun assertKnown(keys: Set<String>, known: Set<String>) {
        assertEquals(emptySet<String>(), keys - known, "fields the Kotlin copy does not model")
    }
}

private fun Map<String, Json>.string(key: String): String = (getValue(key) as Json.Str).value

private fun Map<String, Json>.strings(key: String): List<String> =
    (getValue(key) as Json.Arr).items.map { (it as Json.Str).value }
