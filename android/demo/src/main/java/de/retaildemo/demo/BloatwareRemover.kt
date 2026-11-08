package de.retaildemo.demo

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Löscht Apps, die nicht vom Hersteller stammen: vorinstallierte Werbe-Apps und von Kunden installierte Apps.
 *
 * Ohne Geräteverwaltung (Device Owner) darf eine App andere Apps nicht still löschen – Android zeigt
 * jedes Mal "Diese App deinstallieren?". Den Dialog bestätigt der Bedienungshilfe-Dienst
 * ([IdleWatcherService]) selbst, aber nur für die App, die gerade entfernt werden soll.
 * Fest eingebaute System-Apps lassen sich so nicht löschen (das geht nur per ADB oder Root).
 */
class BloatwareRemover(private val app: DemoApp) {

    private val mutex = Mutex()
    private val _state = MutableStateFlow("")
    val state: StateFlow<String> = _state

    /** App, deren Deinstallieren-Dialog gerade bestätigt werden darf (Paketname und Name). */
    @Volatile var pending: Pair<String, String>? = null
        private set

    private var result: CompletableDeferred<Int>? = null
    /** Fehlgeschlagene Apps nicht ständig neu versuchen (Paket -> elapsedRealtime). */
    private val failedAt = mutableMapOf<String, Long>()

    private val enabled get() = app.sync.manifest.value?.removeBloatware == true

    fun start(scope: CoroutineScope) {
        scope.launch {
            delay(90_000)
            while (true) {
                if (enabled && app.demoVisible && app.prefs.isConfigured && !app.prefs.isPaused &&
                    IdleWatcherService.instance != null && candidates().isNotEmpty()
                ) runNow()
                delay(10 * 60_000L)
            }
        }
    }

    /** Hersteller- und Google-Apps erkennt man am Paketnamen. */
    private val vendorPrefixes = listOf(
        "com.android.", "com.google.", "android.",
        "com.samsung.", "com.sec.", "com.osp.app.",
        "com.xiaomi.", "com.miui.", "com.mi.",
        "com.huawei.", "com.hihonor.", "com.honor.",
        "com.oppo.", "com.coloros.", "com.heytap.", "com.oplus.", "com.realme.", "com.oneplus.",
        "com.vivo.", "com.bbk.", "com.iqoo.",
        "com.motorola.", "com.lenovo.", "com.sony.", "com.sonymobile.",
        "com.hmdglobal.", "com.evenwell.", "com.nokia.", "com.nothing.", "com.asus.",
        "com.zte.", "com.tcl.", "com.fairphone.",
        "de.retaildemo.",
    )

    private fun isVendor(pkg: String): Boolean {
        if (vendorPrefixes.any { pkg.startsWith(it) }) return true
        val brand = Build.MANUFACTURER.lowercase().filter { it.isLetterOrDigit() }
        return brand.length >= 3 && pkg.split('.').take(2).any { it == brand }
    }

    /** Apps, die jetzt gelöscht würden (Paketname, Name). */
    fun candidates(): List<Pair<String, String>> {
        val pm = app.packageManager
        val keep = buildSet {
            add(app.packageName)
            addAll(app.sync.manifest.value?.bloatwareKeep.orEmpty())
            // Tastatur und Startbildschirm nie löschen – sonst ist das Gerät nicht mehr bedienbar
            Settings.Secure.getString(app.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
                ?.substringBefore('/')?.let { add(it) }
            pm.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY)
                ?.activityInfo?.packageName?.let { add(it) }
            Settings.Secure.getString(app.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                ?.split(':')?.forEach { add(it.substringBefore('/')) }
        }
        val now = SystemClock.elapsedRealtime()
        return runCatching { pm.getInstalledApplications(0) }.getOrDefault(emptyList())
            .asSequence()
            .filter { it.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0 }
            .filter { it.packageName !in keep && !isVendor(it.packageName) }
            .filter { failedAt[it.packageName]?.let { t -> now - t > 6 * 3_600_000L } ?: true }
            .map { it.packageName to it.loadLabel(pm).toString() }
            .sortedBy { it.second.lowercase() }
            .toList()
    }

    /** Alle Kandidaten nacheinander löschen. Gibt eine kurze Zusammenfassung zurück. */
    suspend fun runNow(): String = mutex.withLock {
        val list = withContext(Dispatchers.IO) { candidates() }
        if (list.isEmpty()) return@withLock "Keine Bloatware gefunden".also { _state.value = it }
        if (IdleWatcherService.instance == null) {
            return@withLock "Bedienungshilfe ist aus – Bloatware kann nicht entfernt werden".also { _state.value = it }
        }
        val fromDemo = app.demoVisible
        var removed = 0
        val failed = mutableListOf<String>()
        for ((pkg, label) in list) {
            if (app.prefs.isPaused) break
            _state.value = "Entferne $label …"
            if (uninstall(pkg, label)) removed++ else {
                failed += label
                failedAt[pkg] = SystemClock.elapsedRealtime()
            }
        }
        app.bloatRemovalUntil = 0
        // Danach wieder die Demo zeigen (lief vorher die Demo und nicht die Einstellungen)
        if (fromDemo && app.schedule.active.value && !app.prefs.isPaused) ScheduleManager.wakeAndStartDemo(app)
        val summary = buildString {
            append("$removed App(s) entfernt")
            if (failed.isNotEmpty()) append(", nicht möglich: ${failed.joinToString()}")
        }
        Log.i(TAG, summary)
        _state.value = summary
        summary
    }

    private suspend fun uninstall(pkg: String, label: String): Boolean {
        val done = CompletableDeferred<Int>()
        result = done
        pending = pkg to label
        app.bloatRemovalUntil = SystemClock.elapsedRealtime() + 30_000
        try {
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pi = PendingIntent.getBroadcast(app, 7, Intent(app, BloatwareResultReceiver::class.java), flags)
            withContext(Dispatchers.Main) { app.packageManager.packageInstaller.uninstall(pkg, pi.intentSender) }
            val status = withTimeoutOrNull(25_000) { done.await() }
            if (status == null) {
                // Dialog wurde nicht bestätigt (unbekanntes Layout?) -> schließen
                IdleWatcherService.instance?.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            }
            return status == PackageInstaller.STATUS_SUCCESS ||
                runCatching { app.packageManager.getApplicationInfo(pkg, 0) }.isFailure
        } catch (e: Exception) {
            Log.w(TAG, "$pkg konnte nicht entfernt werden", e)
            return false
        } finally {
            pending = null
            result = null
            delay(800)
        }
    }

    internal fun onResult(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { runCatching { context.startActivity(it) } }
            return
        }
        if (status != PackageInstaller.STATUS_SUCCESS) {
            Log.w(TAG, "Entfernen fehlgeschlagen: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
        }
        result?.complete(status)
    }

    companion object { const val TAG = "DemoBloatware" }
}

class BloatwareResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = context.demoApp.bloatware.onResult(context, intent)
}
