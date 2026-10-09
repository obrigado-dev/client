package dev.obrigado.jetbrains

import java.io.File
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Running the renderer, with nothing of the IDE in it — so it can be tested against real
 * processes on a machine with no IDE at all.
 *
 * Every failure is null, which hides the widget. That is the correct failure for an
 * advertisement: the IDE looks exactly as it did before the plugin was installed. An error
 * surfaced into somebody's status bar would be worse than showing no ad at all.
 */
internal object Renderer {
    /** Matches the other hosts. The batch behind a line is cached for far longer. */
    const val REFRESH_SECONDS = 30L

    const val TIMEOUT_MS = 2_000L

    /**
     * One render: spawn, hand over the payload, and settle on the FIRST complete line.
     *
     * The renderer prints its line and then ships beacons before it exits. Waiting for the exit
     * would make the render budget and the beacon budget one budget, and a slow network would
     * leave the status bar empty for an impression that was already queued. So the line settles
     * the render, and the child is left to finish — killing it now would drop the impression it
     * just rendered. The timeout fires only for a child that has said nothing in time.
     */
    fun render(
        argv: List<String>,
        cwd: File,
        payload: String,
        shellEnvironment: Map<String, String>,
        timeoutMs: Long = TIMEOUT_MS,
    ): Sponsored? {
        val executable = argv.firstOrNull()?.let { resolveExecutable(it, shellEnvironment) } ?: return null
        val process =
            try {
                ProcessBuilder(listOf(executable) + argv.drop(1))
                    .directory(cwd)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .apply {
                        // The shell's environment, not the IDE process's: an IDE opened from the
                        // Dock inherits almost none of it, and the renderer needs HOME and PATH.
                        environment().clear()
                        environment().putAll(shellEnvironment)
                    }
                    .start()
            } catch (_: IOException) {
                return null
            }

        try {
            process.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
        } catch (_: IOException) {
            // The child closed its stdin, or has already exited. What it printed still decides.
        }

        val line = firstLine(process, timeoutMs) ?: return null
        return parseSponsored(jsTrim(line))
    }

    private fun firstLine(process: Process, timeoutMs: Long): String? {
        val line = CompletableFuture<String?>()
        // A thread of its own, because the read blocks and the IDE's pools are not for blocking
        // on a child process. It ends when the line arrives, or when the stream closes because
        // the child exited or was killed below.
        Thread(
                {
                    try {
                        line.complete(
                            process.inputStream.bufferedReader(Charsets.UTF_8).lineSequence().firstOrNull {
                                jsTrim(it).isNotEmpty()
                            }
                        )
                    } catch (_: IOException) {
                        line.complete(null)
                    }
                },
                "obrigado-statusline",
            )
            .apply { isDaemon = true }
            .start()

        return try {
            line.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            // Children first: one that inherited the pipe would otherwise hold the reader open.
            process.descendants().forEach { it.destroyForcibly() }
            process.destroyForcibly()
            null
        } catch (_: ExecutionException) {
            null
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        }
    }

    /**
     * `obrigado` on the shell's PATH, then where the installer puts it.
     *
     * The fallback is `install.sh`'s own default, `~/.local/bin` (or `OBRIGADO_INSTALL_DIR`), for
     * the developer who installed it and never added that directory to PATH — the installer
     * says so and moves on, and the IDE should not be the place they find out. A name with a
     * path separator in it is a path, and is used as given.
     */
    fun resolveExecutable(
        name: String,
        environment: Map<String, String>,
        windows: Boolean = File.separatorChar == '\\',
    ): String? {
        if (name.isEmpty()) return null
        if (name.contains('/') || name.contains(File.separatorChar)) return name

        val path = environment.entries.firstOrNull { it.key.equals("PATH", ignoreCase = windows) }?.value
        val directories =
            path.orEmpty().split(File.pathSeparatorChar).filter { it.isNotEmpty() } +
                listOfNotNull(environment["OBRIGADO_INSTALL_DIR"], environment["HOME"]?.let { "$it/.local/bin" })
        val names = if (windows) listOf("$name.exe", "$name.cmd", "$name.bat", name) else listOf(name)

        return directories
            .asSequence()
            .flatMap { directory -> names.asSequence().map { File(directory, it) } }
            .firstOrNull { it.isFile && it.canExecute() }
            ?.absolutePath
    }

    /**
     * What the renderer reads on stdin.
     *
     * `session_id` is one per IDE process per project, not one per machine: a constant would make
     * every window share one cached batch, so the first window's dependencies would decide the
     * ads and every other project's would never be funded. `version` is the IDE's own build —
     * `IU-262.10968.63` — because every JetBrains IDE reports as one agent, and the build is what
     * still says which one it was. `surface_version` is this plugin's (A30).
     *
     * `focused` and `input_at` are what the server's attention rule reads from an editor, which has
     * no terminal and no prompt of its own: whether this project's window was in front, and when
     * the person last typed or clicked anywhere in the IDE (epoch milliseconds).
     */
    fun payload(
        sessionId: String,
        cwd: String,
        surfaceVersion: String?,
        hostVersion: String?,
        focused: Boolean,
        inputAt: Long?,
    ): String =
        jsonObject(
            listOfNotNull(
                "session_id" to sessionId,
                "cwd" to cwd,
                surfaceVersion?.let { "surface_version" to it },
                hostVersion?.let { "version" to it },
                "focused" to focused,
                inputAt?.let { "input_at" to it },
            )
        )
}
