package dev.obrigado.jetbrains

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/** The reader's grammar is covered by the shared vectors; these are the parts they cannot reach. */
class JsonTest {
    @Test
    fun `what the payload writer escapes, the reader reads back unchanged`() {
        val awkward = listOf("", "plain", "\"quoted\"", "back\\slash", "line\nbreak\r\n", "tab\t", "\u0000\u001f", "café 🚀", "</script>")
        for (value in awkward) {
            assertEquals(Json.Str(value), parseJson(jsonString(value)), "round trip of ${jsonString(value)}")
        }
    }

    @Test
    fun `the payload is one object of string fields in the order given`() {
        val text = jsonObject(listOf("session_id" to "jetbrains-1-/a b", "cwd" to "/a b"))
        assertEquals("{\"session_id\":\"jetbrains-1-/a b\",\"cwd\":\"/a b\"}", text)
        assertEquals(
            Json.Obj(mapOf("session_id" to Json.Str("jetbrains-1-/a b"), "cwd" to Json.Str("/a b"))),
            parseJson(text),
        )
    }

    @Test
    fun `values of every kind`() {
        assertEquals(
            Json.Obj(
                mapOf(
                    "n" to Json.Num(-1500.0),
                    "t" to Json.Bool(true),
                    "z" to Json.Null,
                    "a" to Json.Arr(listOf(Json.Num(0.0), Json.Arr(emptyList()), Json.Obj(emptyMap()))),
                )
            ),
            parseJson("""{ "n" : -1.5e3 , "t":true,"z":null,"a":[0,[],{}] }"""),
        )
    }

    @Test
    fun `a hostile nesting depth is refused, not recursed into`() {
        assertNull(parseJson("[".repeat(100_000) + "]".repeat(100_000)))
        val shallow = "[".repeat(50) + "]".repeat(50)
        assertEquals(Json.Arr::class, parseJson(shallow)!!::class)
    }
}
