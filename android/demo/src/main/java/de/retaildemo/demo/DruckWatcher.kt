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

    /** Laden-Logo für die Einblendung (PNG), wird einmal geladen. */
    @Volatile var logo: ByteArray? = null
        private set

    fun api() = ApiClient(app.prefs.serverUrl, app.prefs.deviceToken)

    fun start(scope: CoroutineScope) {
        scope.launch {
            while (true) {
                val enabled = app.sync.manifest.value?.druckPromo?.let { it.everyN > 0 } == true
                if (!enabled) {
                    _active.value = false
                } else if (app.demoVisible && app.prefs.isConfigured && !app.prefs.isPaused) {
                    _active.value = try {
                        val s = api().druckStatus()
                        if (s.active && logo == null) logo = runCatching { api().druckLogo() }.getOrNull()
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
