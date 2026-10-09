package dev.obrigado.jetbrains

import java.io.File
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.readText
import kotlin.io.path.writeText
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.DisabledOnOs
import org.junit.jupiter.api.condition.OS
import org.junit.jupiter.api.io.TempDir

/**
 * Against real child processes, because that is where this goes wrong: a line that arrives
 * before the child exits, a child that never answers, a PATH the IDE was not launched with.
 */
@DisabledOnOs(OS.WINDOWS, disabledReason = "the fake renderers are POSIX shell scripts")
class RendererTest {
    @TempDir lateinit var dir: Path

    private val line = """{"label":"oss-sponsor","copy":"hello","url":"https://obrigado.dev/c/tok"}"""

    private fun environment(): Map<String, String> = mapOf("PATH" to "/usr/bin:/bin", "HOME" to dir.toString())

    private fun script(name: String, body: String): File =
        dir.resolve(name).toFile().apply {
            writeText("#!/bin/sh\n$body\n")
            setExecutable(true)
        }

    private fun render(executable: File, timeoutMs: Long = Renderer.TIMEOUT_MS): Sponsored? =
        Renderer.render(
            argv = listOf(executable.path, "statusline", "--agent", "jetbrains", "--json"),
            cwd = dir.toFile(),
            payload = """{"session_id":"s"}""",
            shellEnvironment = environment(),
            timeoutMs = timeoutMs,
        )

    @Test
    fun `the first line settles the render, and the child is left to ship its beacons`() {
        val renderer = script("renderer", "printf '%s\\n' '$line'\nsleep 1\ntouch \"$dir/finished\"")
        val started = System.nanoTime()

        val ad = render(renderer)

        assertEquals("hello", ad?.copy)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 900, "waited for the child to exit")
        val finished = dir.resolve("finished").toFile()
        val deadline = System.currentTimeMillis() + 5_000
        while (!finished.exists() && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertTrue(finished.exists(), "the child was killed after answering")
    }

    @Test
    fun `a child that says nothing in time is killed, and the render is empty`() {
        val renderer = script("renderer", "echo $$ > \"$dir/pid\"\nexec sleep 30")

        assertNull(render(renderer, timeoutMs = 300))

        val pid = dir.resolve("pid").readText().trim().toLong()
        val deadline = System.currentTimeMillis() + 2_000
        while (ProcessHandle.of(pid).map { it.isAlive }.orElse(false) && System.currentTimeMillis() < deadline) {
            Thread.sleep(20)
        }
        assertFalse(ProcessHandle.of(pid).map { it.isAlive }.orElse(false), "the silent child is still running")
    }

    @Test
    fun `the payload arrives on stdin and the host's arguments on argv`() {
        val renderer = script("renderer", "cat > \"$dir/stdin\"\necho \"$@\" > \"$dir/argv\"\nprintf '%s\\n' '$line'")

        assertNotNull(render(renderer))

        assertEquals("""{"session_id":"s"}""", dir.resolve("stdin").readText())
        assertEquals("statusline --agent jetbrains --json", dir.resolve("argv").readText().trim())
    }

    @Test
    fun `blank lines are skipped, and a last line without a newline still counts`() {
        val renderer = script("renderer", "printf '\\n  \\n%s' '$line'")

        assertEquals("hello", render(renderer)?.copy)
    }

    @Test
    fun `anything that is not a complete line is nothing`() {
        assertNull(render(script("garbage", "echo 'not json'")))
        assertNull(render(script("silent", "exit 0")))
        assertNull(render(script("failing", "echo boom >&2\nexit 3")))
        assertNull(render(dir.resolve("missing").toFile()))
    }

    @Test
    fun `obrigado is found on the shell's PATH first, then where the installer puts it`() {
        val onPath = dir.resolve("path").createDirectories()
        val installed = dir.resolve(".local/bin").createDirectories()
        val custom = dir.resolve("custom").createDirectories()
        fun executable(directory: Path) = directory.resolve("obrigado").toFile().apply { writeText("#!/bin/sh\n"); setExecutable(true) }

        val fallback = executable(installed)
        val home = mapOf("PATH" to "/usr/bin:/bin", "HOME" to dir.toString())
        assertEquals(fallback.absolutePath, Renderer.resolveExecutable("obrigado", home, windows = false))

        val preferred = executable(onPath)
        val withPath = home + ("PATH" to "$onPath:/usr/bin")
        assertEquals(preferred.absolutePath, Renderer.resolveExecutable("obrigado", withPath, windows = false))

        val chosen = executable(custom)
        val withInstallDir = home + ("OBRIGADO_INSTALL_DIR" to custom.toString())
        assertEquals(chosen.absolutePath, Renderer.resolveExecutable("obrigado", withInstallDir, windows = false))
    }

    @Test
    fun `a file that is not executable is not a renderer, and a path is used as given`() {
        dir.resolve(".local/bin").createDirectories().resolve("obrigado").writeText("not a program")
        val home = mapOf("PATH" to "/usr/bin:/bin", "HOME" to dir.toString())

        assertNull(Renderer.resolveExecutable("obrigado", home, windows = false))
        assertEquals("/opt/obrigado/bin/obrigado", Renderer.resolveExecutable("/opt/obrigado/bin/obrigado", home, windows = false))
        assertNull(Renderer.resolveExecutable("", home, windows = false))
    }

    @Test
    fun `the payload names the session, the project, this plugin, the IDE and the window's attention`() {
        val payload =
            Renderer.payload(
                sessionId = "jetbrains-u-/p",
                cwd = "/p",
                surfaceVersion = "0.1.0",
                hostVersion = "IU-262.10968.63",
                focused = true,
                inputAt = 1_790_000_000_000,
            )
        assertEquals(
            """{"session_id":"jetbrains-u-/p","cwd":"/p","surface_version":"0.1.0","version":"IU-262.10968.63",""" +
                """"focused":true,"input_at":1790000000000}""",
            payload,
        )
        assertEquals(
            """{"session_id":"s","cwd":"/p","focused":false}""",
            Renderer.payload(
                sessionId = "s",
                cwd = "/p",
                surfaceVersion = null,
                hostVersion = null,
                focused = false,
                inputAt = null,
            ),
        )
    }
}
