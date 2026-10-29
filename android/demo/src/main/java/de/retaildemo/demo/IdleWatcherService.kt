package de.retaildemo.demo

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast

/**
 * Bedienungshilfe-Dienst, der im Hintergrund läuft:
 * - Startet die Demo nach [Manifest.idleTimeoutS] Sekunden ohne Bedienung wieder (wie bei Apple/Samsung).
 * - Schaltet das Display sofort wieder ein, wenn jemand das Gerät in Standby versetzt.
 * - Sperrt (falls aktiviert) die Sprach- und Passwort-Einstellungen.
 * - Außerhalb der Betriebszeiten: Display nach Inaktivität wieder ausschalten.
 */
class IdleWatcherService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())
    private var lastInteraction = SystemClock.elapsedRealtime()
    private var lastBlockToast = 0L
    private var lastUninstallBlock = 0L

    private val check = object : Runnable {
        override fun run() {
            checkIdle()
            handler.postDelayed(this, 5_000)
        }
    }

    private val screenOffReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val app = demoApp
            if (!app.prefs.isConfigured || !app.schedule.active.value) return
            // Standby während der Betriebszeit -> Display wieder an, Demo läuft weiter
            handler.postDelayed({ ScheduleManager.wakeAndStartDemo(this@IdleWatcherService) }, 300)
        }
    }

    override fun onServiceConnected() {
        instance = this
        lastInteraction = SystemClock.elapsedRealtime()
        handler.post(check)
        registerReceiver(screenOffReceiver, IntentFilter(Intent.ACTION_SCREEN_OFF))
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName) return

        // Deinstallieren-Dialog so früh wie möglich erkennen – auch schon beim Aufbau des Inhalts
        if (pkg.contains("packageinstaller")) checkUninstallDialog(event)

        // Inhaltsänderungen (Animationen, Uhr, …) sind keine Bedienung durch einen Kunden
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            lastInteraction = SystemClock.elapsedRealtime()
        }

        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            demoApp.prefs.blockSettings && SettingsGuard.isForbidden(event)
        ) {
            performGlobalAction(GLOBAL_ACTION_HOME)
            val now = SystemClock.elapsedRealtime()
            if (now - lastBlockToast > 3_000) {
                lastBlockToast = now
                Toast.makeText(this, "Diese Einstellung ist auf Vorführgeräten gesperrt", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /** Hinweise darauf, dass es ums Deinstallieren geht (nicht um Installieren/Aktualisieren). */
    private val uninstallPattern = Regex(
        "(?i)(deinstall|uninstall|désinstall|disinstall|desinstal|odinstal|verwijder|удал|kaldır)"
    )

    private fun looksLikeUninstall(className: CharSequence?, texts: List<String>) =
        className?.contains("uninstall", ignoreCase = true) == true || texts.any { uninstallPattern.containsMatchIn(it) }

    private val appLabelPattern by lazy {
        Regex("\\b" + Regex.escape(applicationInfo.loadLabel(packageManager).toString()) + "\\b")
    }

    // Zustand des aktuell geöffneten Installer-Fensters. Abfragen des Fensterinhalts müssen vom Installer
    // selbst beantwortet werden – deshalb sparsam: nur kurz nach dem Öffnen, gedrosselt, einmal entschieden ist entschieden.
    private var installerWindowSince = 0L
    private var installerWindowClass: CharSequence? = null
    private var installerWindowDecided = false
    private var lastInstallerScan = 0L

    /** Will jemand diese App deinstallieren? Dann Dialog sofort schließen und nach der PIN fragen. */
    private fun checkUninstallDialog(event: AccessibilityEvent) {
        val now = SystemClock.elapsedRealtime()
        if (now < demoApp.uninstallUnlockedUntil || now - lastUninstallBlock < 3_000) return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            installerWindowSince = now
            installerWindowClass = event.className
            installerWindowDecided = false
            lastInstallerScan = 0
            // Falls keine weiteren Ereignisse kommen: zweimal nachsehen
            for (delay in longArrayOf(300, 900)) handler.postDelayed({ scanInstallerWindow(null) }, delay)
        }
        if (installerWindowDecided || now - installerWindowSince > 2_000) return

        // 1. Texte direkt aus dem Ereignis (kostet nichts)
        val eventTexts = event.text.map { it.toString() }
        if (eventTexts.any { appLabelPattern.containsMatchIn(it) } && looksLikeUninstall(installerWindowClass, eventTexts)) {
            installerWindowDecided = true
            blockUninstall(now)
            return
        }
        // 2. Fensterinhalt lesen – höchstens alle 150 ms
        if (now - lastInstallerScan >= 150) scanInstallerWindow(event.source)
    }

    private fun scanInstallerWindow(source: android.view.accessibility.AccessibilityNodeInfo?) {
        val now = SystemClock.elapsedRealtime()
        if (installerWindowDecided || now - installerWindowSince > 2_000 ||
            now < demoApp.uninstallUnlockedUntil || now - lastUninstallBlock < 3_000
        ) return
        lastInstallerScan = now
        var root = source ?: rootInActiveWindow ?: return
        repeat(10) { root = root.parent ?: return@repeat }
        if (root.packageName?.contains("packageinstaller") != true) return
        val texts = textsOf(root)
        if (texts.none { appLabelPattern.containsMatchIn(it) }) return // Inhalt noch nicht geladen
        installerWindowDecided = true
        if (looksLikeUninstall(installerWindowClass, texts)) blockUninstall(now)
    }

    private fun textsOf(root: android.view.accessibility.AccessibilityNodeInfo?): List<String> {
        val texts = mutableListOf<String>()
        var visited = 0
        fun collect(node: android.view.accessibility.AccessibilityNodeInfo?, depth: Int) {
            if (node == null || depth > 7 || visited >= 40) return
            visited++
            node.text?.let { texts += it.toString() }
            for (i in 0 until node.childCount) collect(node.getChild(i), depth + 1)
        }
        collect(root, 0)
        return texts
    }

    private fun blockUninstall(now: Long) {
        lastUninstallBlock = now
        performGlobalAction(GLOBAL_ACTION_BACK)
        android.util.Log.i("DemoGuard", "Deinstallieren abgefangen")
        // Erst wenn der System-Dialog sicher geschlossen ist, die PIN-Abfrage öffnen
        handler.postDelayed({
            startActivity(
                Intent(this, UninstallPinActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }, 700)
    }

    private fun checkIdle() {
        val app = demoApp
        // Während eines freigegebenen Deinstallierens (nach PIN) die Demo nicht dazwischenschieben
        if (app.isUiVisible || !app.prefs.isConfigured || SystemClock.elapsedRealtime() < app.uninstallUnlockedUntil) {
            lastInteraction = SystemClock.elapsedRealtime()
            return
        }
        val timeoutMs = (app.sync.manifest.value?.idleTimeoutS ?: 30) * 1000L
        if (SystemClock.elapsedRealtime() - lastInteraction < timeoutMs) return
        lastInteraction = SystemClock.elapsedRealtime()

        if (app.schedule.active.value) {
            ScheduleManager.wakeAndStartDemo(this)
        } else if (Build.VERSION.SDK_INT >= 28 && getSystemService(PowerManager::class.java).isInteractive) {
            // Ruhezeit: jemand hat das Gerät eingeschaltet und nicht mehr benutzt -> wieder schlafen
            performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        handler.removeCallbacks(check)
        runCatching { unregisterReceiver(screenOffReceiver) }
        super.onDestroy()
    }

    companion object {
        @Volatile var instance: IdleWatcherService? = null
            private set
    }
}

/** Erkennt Einstellungsseiten für Sprache und Displaysperre/Passwort (AOSP, Samsung, Xiaomi, …). */
object SettingsGuard {
    private val CLASS_PATTERN = Regex(
        "(?i)(locale|language|inputmethodandlanguage|chooselock|confirmlock|setnewpassword|" +
            "screenlock|lockscreensettings|locksettings|password|lockpattern|lockpin|keyguard.*setting)"
    )
    private val TITLE_PATTERN = Regex(
        "(?i)\\b(sprachen?|sprache und eingabe|languages?|language & input|langues?|idiomas?|lingue|dil|" +
            "displaysperre|bildschirmsperre|sperrbildschirm|bildschirmsperrtyp|entsperrmethode|" +
            "screen lock|lock screen|screen lock type|" +
            "passwort|kennwort|password|pin|muster|pattern)\\b"
    )

    fun isForbidden(event: AccessibilityEvent): Boolean {
        val pkg = event.packageName?.toString()?.lowercase() ?: return false
        if (!pkg.contains("settings") && !pkg.contains("securitycenter")) return false
        val cls = event.className?.toString() ?: ""
        if (CLASS_PATTERN.containsMatchIn(cls)) return true
        val title = event.text.joinToString(" ")
        return title.isNotBlank() && TITLE_PATTERN.containsMatchIn(title)
    }
}
