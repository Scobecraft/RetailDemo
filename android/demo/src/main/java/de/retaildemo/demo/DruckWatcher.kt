package de.retaildemo.demo

import android.util.Log
import de.retaildemo.core.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Fragt beim Server nach, ob gerade ein 3D-Druck läuft (Druckmonitor-App sendet, Drucker druckt,
 * Kamera liefert Bilder). Nur dann zeigt die Demo die Einblendung "3D-Druck live".
 * Gefragt wird nur, solange die Demo läuft und die Einblendung auf der Webseite eingeschaltet ist.
 */
class DruckWatcher(private val app: DemoApp) {

    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active

    /** Laden-Logo (PNG) für die Einblendung und den Übergang zwischen den Medien.
     *  Wird einmal vom Server geladen und auf dem Gerät gespeichert (funktioniert dann auch offline). */
    private val logoFile = java.io.File(app.filesDir, "logo.png")
    @Volatile var logo: ByteArray? = runCatching { logoFile.takeIf { it.exists() }?.readBytes() }.getOrNull()
        private set

    private suspend fun refreshLogo() {
        val bytes = runCatching { api().druckLogo() }.getOrNull() ?: return
        if (bytes.size > 100 && !bytes.contentEquals(logo)) {
            logo = bytes
            runCatching { logoFile.writeBytes(bytes) }
        }
    }

    fun api() = ApiClient(app.prefs.serverUrl, app.prefs.deviceToken)

    fun start(scope: CoroutineScope) {
        scope.launch {
            var lastLogo = 0L
            while (true) {
                // Logo beim Start und danach einmal am Tag auffrischen
                if (app.prefs.isConfigured && (logo == null || System.currentTimeMillis() - lastLogo > 86_400_000L)) {
                    refreshLogo()
                    if (logo != null) lastLogo = System.currentTimeMillis()
                }
                val enabled = app.sync.manifest.value?.druckPromo?.let { it.everyN > 0 } == true
                if (!enabled) {
                    _active.value = false
                } else if (app.demoVisible && app.prefs.isConfigured && !app.prefs.isPaused) {
                    _active.value = try {
                        val s = api().druckStatus()
                        s.active
                    } catch (e: Exception) {
                        Log.d(TAG, "Druckstatus nicht abrufbar: ${e.message}")
                        false
                    }
                }
                delay(20_000)
            }
        }
    }

    companion object { private const val TAG = "DemoDruck" }
}
