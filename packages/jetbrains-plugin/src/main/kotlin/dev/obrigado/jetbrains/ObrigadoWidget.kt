package dev.obrigado.jetbrains

import com.intellij.ide.BrowserUtil
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.ControlFlowException
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import com.intellij.util.EnvironmentUtil
import com.intellij.util.concurrency.AppExecutorUtil
import java.awt.Component
import java.awt.event.MouseEvent
import java.io.File
import java.util.UUID
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Obrigado's surface in every IntelliJ-based IDE.
 *
 * The whole plugin is one status bar widget, registered through the documented
 * `com.intellij.statusBarWidgetFactory` extension point: persistent text, a tooltip and a click,
 * in a slot the IDE owns and lets the developer hide from its own status bar menu. Nothing of the
 * IDE is patched, and no other plugin's classes are touched. Staying inside the documented API is
 * the security and compatibility boundary (INVARIANT 11, §3).
 *
 * Delivery is not reimplemented. This runs `obrigado statusline --agent jetbrains --json` and draws
 * the parts, exactly as the VS Code extension does. Rotation, batching, beacons and the disclosure
 * stay in the one renderer.
 *
 * ── Why this surface bills like VS Code's, and where that rule lives ──
 *
 * A status bar is visible whenever the window is, including while somebody reads code with no
 * agent involved. A21 settles it session-scoped: an editor impression counts only while an agent
 * host has rendered recently. This plugin does nothing special for that. The renderer's gate
 * returns nothing when no agent is live, so the widget goes dark rather than rendering unbilled —
 * and no plugin can opt itself into billing by forgetting to ask.
 */
class ObrigadoWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = ObrigadoWidget.ID

    override fun getDisplayName(): String = "Obrigado"

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget = ObrigadoWidget(project)

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

/**
 * The agent id this plugin reports. One for every JetBrains IDE, because they are one platform
 * running one plugin; the IDE's build, sent as `version`, still says which one rendered.
 */
internal const val AGENT = "jetbrains"

/** Matches `<id>` in plugin.xml. */
private const val PLUGIN_ID = "dev.obrigado"

internal class ObrigadoWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    @Volatile private var current: Sponsored? = null

    @Volatile private var statusBar: StatusBar? = null

    private var poll: ScheduledFuture<*>? = null

    override fun ID(): String = ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        poll =
            AppExecutorUtil.getAppScheduledExecutorService()
                .scheduleWithFixedDelay(::refresh, 0, Renderer.REFRESH_SECONDS, TimeUnit.SECONDS)
    }

    override fun dispose() {
        poll?.cancel(false)
        poll = null
        statusBar = null
    }

    /**
     * Empty text hides the widget, which is how every failure looks: exactly as the IDE did
     * before the plugin was installed.
     */
    override fun getText(): String = current?.let(::statusText).orEmpty()

    override fun getTooltipText(): String? = current?.let(::tooltipHtml)

    override fun getAlignment(): Float = Component.LEFT_ALIGNMENT

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
        // The signed `/c/<token>` URL, never the advertiser's destination: the redirect is what
        // records the click and sanitises where it lands.
        current?.url?.takeIf(::isOpenable)?.let { BrowserUtil.browse(it) }
    }

    private fun refresh() {
        if (project.isDisposed) return
        current =
            try {
                render()
            } catch (error: Exception) {
                if (error is ControlFlowException) throw error
                // Debug, not error: the IDE reports a logged error to the developer with a red
                // badge, and a missing advertisement is nobody's emergency.
                LOG.debug("render failed", error)
                null
            }
        ApplicationManager.getApplication().invokeLater({ statusBar?.updateWidget(ID) }, ModalityState.any())
    }

    private fun render(): Sponsored? {
        // The login shell's environment, which the IDE loads at startup: an IDE opened from the
        // Dock has none of it otherwise, and it is where both PATH and the override live.
        val shell = EnvironmentUtil.getEnvironmentMap()
        val cwd = project.basePath ?: System.getProperty("user.home")
        return Renderer.render(
            argv = statuslineArgv(AGENT, shell["OBRIGADO_STATUSLINE_COMMAND"]),
            cwd = File(cwd),
            payload =
                Renderer.payload(
                    sessionId = "$AGENT-$SESSION-$cwd",
                    cwd = cwd,
                    // The running descriptor's, so it cannot disagree with what is installed.
                    surfaceVersion = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.version,
                    hostVersion = ApplicationInfo.getInstance().build.asString(),
                ),
            shellEnvironment = shell,
        )
    }

    companion object {
        const val ID = "dev.obrigado.statusline"

        /** One per IDE process, as VS Code's `env.sessionId` is; the project path tells windows apart. */
        private val SESSION: String = UUID.randomUUID().toString()

        private val LOG = Logger.getInstance(ObrigadoWidget::class.java)
    }
}
