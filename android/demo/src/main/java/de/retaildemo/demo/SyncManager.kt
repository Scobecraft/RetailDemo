package de.retaildemo.demo

import android.os.Build
import android.util.Log
import de.retaildemo.core.ApiClient
import de.retaildemo.core.DeviceReport
import de.retaildemo.core.Manifest
import de.retaildemo.core.ManifestItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.security.MessageDigest

/**
 * Gleicht die Inhalte mit dem Server ab:
 * - alle [Manifest.syncIntervalMin] Minuten (Standard: 1x pro Stunde) ein vollständiger Abgleich
 * - alle paar Minuten ein kurzer "Heartbeat", damit die Admin-App sieht, dass das Gerät online ist
 *   (und damit "Jetzt aktualisieren" aus der Admin-App sofort wirkt)
 */
class SyncManager(private val app: DemoApp) {

    private val prefs get() = app.prefs
    private val mutex = Mutex()
    private var nextRetryAt = 0L

    private val _manifest = MutableStateFlow(prefs.manifest)
    val manifest: StateFlow<Manifest?> = _manifest

    private val _contentVersion = MutableStateFlow(0)
    /** Wird nach jedem Abgleich erhöht, damit die Wiedergabe neu geladene Dateien übernimmt. */
    val contentVersion: StateFlow<Int> = _contentVersion

    private val _state = MutableStateFlow("")
    /** Kurzer Text für die Einstellungsseite, z. B. "Lade 2/5 …". */
    val state: StateFlow<String> = _state

    /** Wird von der Demo-Ansicht gesetzt und im Heartbeat gemeldet. */
    @Volatile var playerStatus: String = "Gestartet"

    val mediaDir: File by lazy { File(app.filesDir, "media").apply { mkdirs() } }

    fun localFile(item: ManifestItem) = File(mediaDir, item.id)
    fun isAvailable(item: ManifestItem) = localFile(item).let { it.exists() && it.length() == item.size }

    private fun api() = ApiClient(prefs.serverUrl, prefs.deviceToken)

    fun start(scope: CoroutineScope) {
        scope.launch { syncLoop() }
        scope.launch { heartbeatLoop() }
    }

    fun isDue(): Boolean {
        val interval = (_manifest.value?.syncIntervalMin ?: 60) * 60_000L
        val now = System.currentTimeMillis()
        return prefs.isConfigured && now >= prefs.lastSync + interval && now >= nextRetryAt
    }

    private suspend fun syncLoop() {
        while (true) {
            if (isDue()) syncNow()
            delay(30_000)
        }
    }

    private suspend fun heartbeatLoop() {
        delay(5_000)
        while (true) {
            var waitS = 300
            if (prefs.isConfigured) {
                runCatching { api().heartbeat(report(withSpecs = false)) }
                    .onSuccess {
                        waitS = it.heartbeatIntervalS
                        if (it.syncNow) syncNow()
                    }
                    .onFailure { Log.w(TAG, "Heartbeat fehlgeschlagen", it) }
            }
            delay(waitS * 1000L)
        }
    }

    private fun report(withSpecs: Boolean) = DeviceReport(
        deviceId = prefs.deviceId,
        manufacturer = DeviceInfo.manufacturer(),
        model = Build.MODEL,
        marketingName = DeviceInfo.marketingName(app),
        androidVersion = DeviceInfo.androidVersion(),
        appVersion = BuildConfig.VERSION_NAME,
        specs = if (withSpecs) DeviceInfo.specs(app) else emptyList(),
        syncedHash = prefs.syncedHash,
        status = playerStatus,
        error = prefs.lastError,
        battery = DeviceInfo.batteryPercent(app),
        previousId = prefs.legacyDeviceId,
    )

    /** Vollständiger Abgleich. Gibt null bei Erfolg zurück, sonst die Fehlermeldung. */
    suspend fun syncNow(): String? = mutex.withLock {
        if (!prefs.isConfigured) return "Server nicht eingerichtet"
        _state.value = "Verbinde mit Server …"
        val error = try {
            val api = api()
            val m = api.sync(report(withSpecs = true))
            // Server hat den alten Eintrag übernommen -> alte Zufalls-ID nicht mehr melden
            if (prefs.legacyDeviceId != null) prefs.legacyDeviceId = prefs.deviceId
            var failed = 0
            m.items.forEachIndexed { i, item ->
                if (isAvailable(item)) return@forEachIndexed
                _state.value = "Lade Datei ${i + 1} von ${m.items.size} …"
                try {
                    val f = localFile(item)
                    api.download(item.url, f)
                    if (item.sha256.isNotEmpty() && sha256(f) != item.sha256) {
                        f.delete()
                        error("Prüfsumme falsch")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Download ${item.id} fehlgeschlagen", e)
                    failed++
                }
            }
            // Nicht mehr benötigte Dateien (und abgebrochene Downloads) löschen
            val keep = m.items.map { it.id }.toSet()
            mediaDir.listFiles()?.filter { it.name !in keep }?.forEach { it.delete() }

            prefs.manifest = m
            _manifest.value = m
            _contentVersion.value++
            if (failed == 0) {
                prefs.syncedHash = m.hash
                prefs.lastSync = System.currentTimeMillis()
                null
            } else "$failed Datei(en) konnten nicht geladen werden"
        } catch (e: Exception) {
            Log.w(TAG, "Sync fehlgeschlagen", e)
            e.message ?: e.javaClass.simpleName
        }
        prefs.lastError = error
        // Bei Fehlern in 5 Minuten erneut versuchen statt erst in einer Stunde
        nextRetryAt = if (error != null) System.currentTimeMillis() + 5 * 60_000 else 0
        _state.value = error?.let { "Fehler: $it" } ?: "Aktuell"
        // Admin-App sofort über den neuen Stand informieren
        if (error == null) runCatching { api().heartbeat(report(withSpecs = false)) }
        error
    }

    /** Gerät beim Server abmelden (vor dem Deinstallieren). */
    suspend fun unregister() {
        if (prefs.isConfigured) runCatching { api().unregister(prefs.deviceId) }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    companion object { private const val TAG = "DemoSync" }
}
