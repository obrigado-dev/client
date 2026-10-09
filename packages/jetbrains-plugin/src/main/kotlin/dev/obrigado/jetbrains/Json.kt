package dev.obrigado.jetbrains

/**
 * The JSON this plugin reads and writes: one line from the renderer, one payload to it.
 *
 * Written here rather than borrowed from the IDE. The platform does carry JSON libraries, but
 * which ones a plugin may link against has moved between releases as the platform split its
 * libraries into modules — and a plugin that resolves a class on the IDE it was built against
 * and not on the next one fails in somebody's status bar, not in this build. A reader for
 * RFC 8259 is small, has no such dependency, and is held to `JSON.parse` by the shared vectors.
 *
 * Strict in the same places `JSON.parse` is: no trailing commas, no single quotes, no raw
 * control characters inside a string, no leading zeros, no BOM. Duplicate keys resolve to the
 * last, as they do there.
 */
internal sealed interface Json {
    data class Obj(val fields: Map<String, Json>) : Json

    data class Arr(val items: List<Json>) : Json

    data class Str(val value: String) : Json

    data class Num(val value: Double) : Json

    data class Bool(val value: Boolean) : Json

    data object Null : Json
}

/** The document, or null for anything that is not exactly one JSON value. Never throws. */
internal fun parseJson(text: String): Json? =
    try {
        JsonReader(text).document()
    } catch (_: JsonSyntax) {
        null
    }

/** A string as a JSON literal, quotes included. */
internal fun jsonString(value: String): String =
    buildString(value.length + 2) {
        append('"')
        for (character in value) {
            when {
                character == '"' -> append("\\\"")
                character == '\\' -> append("\\\\")
                character == '\n' -> append("\\n")
                character == '\r' -> append("\\r")
                character == '\t' -> append("\\t")
                character < ' ' -> append("\\u").append(character.code.toString(16).padStart(4, '0'))
                else -> append(character)
            }
        }
        append('"')
    }

/**
 * An object of scalar fields, in the order given: strings, booleans and whole numbers, which is
 * all the payload ever needs. Anything else is written as its string form.
 */
internal fun jsonObject(fields: List<Pair<String, Any>>): String =
    fields.joinToString(separator = ",", prefix = "{", postfix = "}") { (key, value) ->
        val encoded =
            when (value) {
                is Boolean, is Int, is Long -> value.toString()
                else -> jsonString(value.toString())
            }
        "${jsonString(key)}:$encoded"
    }

/** Thrown only inside the reader, and cheap: no stack trace is ever wanted for it. */
private class JsonSyntax : RuntimeException(null, null, false, false)

/**
 * Nesting deeper than this is refused rather than recursed into. The renderer's line is two
 * levels deep; the limit exists so a hostile line cannot spend the thread's stack.
 */
private const val MAX_DEPTH = 64

private class JsonReader(private val text: String) {
    private var at = 0

    fun document(): Json {
        skipSpace()
        val value = value(depth = 0)
        skipSpace()
        if (at != text.length) fail()
        return value
    }

    private fun value(depth: Int): Json {
        if (depth > MAX_DEPTH || at >= text.length) fail()
        return when (text[at]) {
            '{' -> obj(depth)
            '[' -> arr(depth)
            '"' -> Json.Str(string())
            't' -> literal("true", Json.Bool(true))
            'f' -> literal("false", Json.Bool(false))
            'n' -> literal("null", Json.Null)
            else -> number()
        }
    }

    private fun obj(depth: Int): Json.Obj {
        at += 1
        val fields = LinkedHashMap<String, Json>()
        skipSpace()
        if (peek() == '}') {
            at += 1
            return Json.Obj(fields)
        }
        while (true) {
            skipSpace()
            if (peek() != '"') fail()
            val key = string()
            skipSpace()
            expect(':')
            skipSpace()
            fields[key] = value(depth + 1)
            skipSpace()
            when (peek()) {
                ',' -> at += 1
                '}' -> {
                    at += 1
                    return Json.Obj(fields)
                }
                else -> fail()
            }
        }
    }

    private fun arr(depth: Int): Json.Arr {
        at += 1
        val items = ArrayList<Json>()
        skipSpace()
        if (peek() == ']') {
            at += 1
            return Json.Arr(items)
        }
        while (true) {
            skipSpace()
            items += value(depth + 1)
            skipSpace()
            when (peek()) {
                ',' -> at += 1
                ']' -> {
                    at += 1
                    return Json.Arr(items)
                }
                else -> fail()
            }
        }
    }

    private fun string(): String {
        expect('"')
        val out = StringBuilder()
        while (true) {
            if (at >= text.length) fail()
            val character = text[at]
            at += 1
            when {
                character == '"' -> return out.toString()
                character == '\\' -> out.append(escape())
                // Raw control characters are not JSON, whatever a lenient parser would do.
                character < ' ' -> fail()
                else -> out.append(character)
            }
        }
    }

    private fun escape(): Char {
        if (at >= text.length) fail()
        val character = text[at]
        at += 1
        return when (character) {
            '"' -> '"'
            '\\' -> '\\'
            '/' -> '/'
            'b' -> '\b'
            'f' -> '\u000C'
            'n' -> '\n'
            'r' -> '\r'
            't' -> '\t'
            'u' -> {
                // A lone surrogate is legal JSON and survives as one, exactly as in JavaScript.
                if (at + 4 > text.length) fail()
                val code = text.substring(at, at + 4)
                if (!code.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) fail()
                at += 4
                code.toInt(16).toChar()
            }
            else -> fail()
        }
    }

    private fun number(): Json.Num {
        val start = at
        if (peek() == '-') at += 1
        when (peek()) {
            '0' -> at += 1
            in '1'..'9' -> digits()
            else -> fail()
        }
        if (peek() == '.') {
            at += 1
            if (peek() !in '0'..'9') fail()
            digits()
        }
        if (peek() == 'e' || peek() == 'E') {
            at += 1
            if (peek() == '+' || peek() == '-') at += 1
            if (peek() !in '0'..'9') fail()
            digits()
        }
        return Json.Num(text.substring(start, at).toDouble())
    }

    private fun digits() {
        while (peek() in '0'..'9') at += 1
    }

    private fun literal(word: String, value: Json): Json {
        if (!text.startsWith(word, at)) fail()
        at += word.length
        return value
    }

    private fun expect(character: Char) {
        if (peek() != character) fail()
        at += 1
    }

    /** The current character, or NUL past the end — which no branch above accepts. */
    private fun peek(): Char = if (at < text.length) text[at] else '\u0000'

    private fun skipSpace() {
        while (at < text.length && text[at].let { it == ' ' || it == '\t' || it == '\n' || it == '\r' }) at += 1
    }

    private fun fail(): Nothing = throw JsonSyntax()
}
