package de.retaildemo.demo

import android.content.Context
import de.retaildemo.core.ApiClient
import de.retaildemo.core.Manifest
import android.provider.Settings
import java.util.UUID

/** Lokale Einstellungen des Demo-Geräts. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("demo", Context.MODE_PRIVATE)

    /**
     * Dauerhafte Geräte-ID (Android-ID): bleibt auch nach Neuinstallation gleich,
     * damit ein Gerät in der Admin-App nicht doppelt auftaucht.
     */
    val deviceId: String = run {
        @android.annotation.SuppressLint("HardwareIds")
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        androidId?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" }
            ?: sp.getString("device_id", null)
            ?: UUID.randomUUID().toString().also { sp.edit().putString("device_id", it).apply() }
    }

    /** Zufalls-ID älterer App-Versionen; wird dem Server einmalig zum Umstellen gemeldet. */
    var legacyDeviceId: String?
        get() = sp.getString("device_id", null)?.takeIf { it != deviceId }
        set(v) = sp.edit().putString("device_id", v).apply()

    var serverUrl: String
        get() = sp.getString("server_url", "") ?: ""
        set(v) = sp.edit().putString("server_url", ApiClient.normalizeUrl(v)).apply()

    var deviceToken: String
        get() = sp.getString("device_token", "") ?: ""
        set(v) = sp.edit().putString("device_token", v.trim()).apply()

    var pin: String
        get() = sp.getString("pin", "1234") ?: "1234"
        set(v) = sp.edit().putString("pin", v).apply()

    /** Sprache/Passwort-Einstellungen für Kunden sperren. */
    var blockSettings: Boolean
        get() = sp.getBoolean("block_settings", true)
        set(v) = sp.edit().putBoolean("block_settings", v).apply()

    /** Helligkeit immer auf 100 % stellen. */
    var maxBrightness: Boolean
        get() = sp.getBoolean("max_brightness", true)
        set(v) = sp.edit().putBoolean("max_brightness", v).apply()

    /** Uhr-App (Wecker, Timer) für Kunden sperren. */
    var blockAlarms: Boolean
        get() = sp.getBoolean("block_alarms", true)
        set(v) = sp.edit().putBoolean("block_alarms", v).apply()

    /** Demo pausiert bis zu diesem Zeitpunkt (ms seit 1970). 0 = nicht pausiert, Long.MAX_VALUE = bis "Fortsetzen". */
    var pausedUntil: Long
        get() = sp.getLong("paused_until", 0)
        set(v) = sp.edit().putLong("paused_until", v).apply()

    val isPaused get() = System.currentTimeMillis() < pausedUntil

    /** Versionsnummer und Prüfsumme eines im Hintergrund schon heruntergeladenen App-Updates (0 = keins). */
    var updateReadyCode: Int
        get() = sp.getInt("update_ready_code", 0)
        set(v) = sp.edit().putInt("update_ready_code", v).apply()

    var updateReadySha: String
        get() = sp.getString("update_ready_sha", "") ?: ""
        set(v) = sp.edit().putString("update_ready_sha", v).apply()

    /** Zuletzt beantwortete "Jetzt aktualisieren"-Anforderung von der Webseite (Dialog nur einmal je Anforderung). */
    var handledInstallRequest: Long
        get() = sp.getLong("handled_install_request", 0)
        set(v) = sp.edit().putLong("handled_install_request", v).apply()

    var lastCleanup: Long
        get() = sp.getLong("last_cleanup", 0)
        set(v) = sp.edit().putLong("last_cleanup", v).apply()

    var lastSync: Long
        get() = sp.getLong("last_sync", 0)
        set(v) = sp.edit().putLong("last_sync", v).apply()

    var syncedHash: String?
        get() = sp.getString("synced_hash", null)
        set(v) = sp.edit().putString("synced_hash", v).apply()

    var lastError: String?
        get() = sp.getString("last_error", null)
        set(v) = sp.edit().putString("last_error", v).apply()

    var manifest: Manifest?
        get() = sp.getString("manifest", null)?.let {
            runCatching { ApiClient.JSON.decodeFromString<Manifest>(it) }.getOrNull()
        }
        set(v) = sp.edit().putString("manifest", v?.let { ApiClient.JSON.encodeToString(it) }).apply()

    val isConfigured get() = serverUrl.isNotBlank() && deviceToken.isNotBlank()
}
