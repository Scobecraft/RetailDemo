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

    // ---------------- Diebstahlschutz (überlebt Neustart) ----------------
    /** Gerät ist gesperrt (Sperrbildschirm + Alarm). Wird nur vom Server aufgehoben. */
    var theftLocked: Boolean
        get() = sp.getBoolean("theft_locked", false)
        set(v) = sp.edit().putBoolean("theft_locked", v).apply()

    /** Nummer des letzten Sperrbefehls (Server). Steigt bei jedem Sperren/Entsperren. */
    var theftLockSeq: Long
        get() = sp.getLong("theft_lock_seq", 0)
        set(v) = sp.edit().putLong("theft_lock_seq", v).apply()

    var theftLockReason: String
        get() = sp.getString("theft_lock_reason", "") ?: ""
        set(v) = sp.edit().putString("theft_lock_reason", v).apply()

    /** Diebstahlschutz scharf (Geofence aktiv laut Server). */
    var theftArmed: Boolean
        get() = sp.getBoolean("theft_armed", false)
        set(v) = sp.edit().putBoolean("theft_armed", v).apply()

    /** Geofence-Daten (für die eigene Prüfung, auch offline). */
    var fenceLat: Double
        get() = Double.fromBits(sp.getLong("fence_lat", 0))
        set(v) = sp.edit().putLong("fence_lat", v.toRawBits()).apply()
    var fenceLon: Double
        get() = Double.fromBits(sp.getLong("fence_lon", 0))
        set(v) = sp.edit().putLong("fence_lon", v.toRawBits()).apply()
    var fenceHasCenter: Boolean
        get() = sp.getBoolean("fence_has", false)
        set(v) = sp.edit().putBoolean("fence_has", v).apply()
    var fenceRadiusM: Int
        get() = sp.getInt("fence_radius", 150)
        set(v) = sp.edit().putInt("fence_radius", v).apply()
    var fenceMinAcc: Int
        get() = sp.getInt("fence_minacc", 60)
        set(v) = sp.edit().putInt("fence_minacc", v).apply()
    var fenceDwellS: Int
        get() = sp.getInt("fence_dwell", 180)
        set(v) = sp.edit().putInt("fence_dwell", v).apply()
    var fenceGraceS: Int
        get() = sp.getInt("fence_grace", 300)
        set(v) = sp.edit().putInt("fence_grace", v).apply()
    var fenceReportS: Int
        get() = sp.getInt("fence_report", 120)
        set(v) = sp.edit().putInt("fence_report", v).apply()
    /** Zeitpunkt (ms), seit dem das Gerät nach dem Scharfschalten läuft (Schonzeit). */
    var armedAt: Long
        get() = sp.getLong("armed_at", 0)
        set(v) = sp.edit().putLong("armed_at", v).apply()
    /** Seit wann durchgehend außerhalb (ms, 0 = drinnen/unbekannt). */
    var outsideSince: Long
        get() = sp.getLong("outside_since", 0)
        set(v) = sp.edit().putLong("outside_since", v).apply()
    /** Noch nicht gesendete Standorte (JSON-Zeilen) sammeln sich in einer Datei – hier nur der Zeitstempel der letzten Meldung. */
    var lastLocReport: Long
        get() = sp.getLong("last_loc_report", 0)
        set(v) = sp.edit().putLong("last_loc_report", v).apply()

    // --- strenger Fehlalarm-Schutz / Laden-WLAN / Zeitplan / Entsperr-Passwort ---
    var fenceGpsOnly: Boolean
        get() = sp.getBoolean("fence_gpsonly", true)
        set(v) = sp.edit().putBoolean("fence_gpsonly", v).apply()
    var fenceMinFixes: Int
        get() = sp.getInt("fence_minfixes", 4)
        set(v) = sp.edit().putInt("fence_minfixes", v).apply()
    var fenceMarginM: Int
        get() = sp.getInt("fence_margin", 50)
        set(v) = sp.edit().putInt("fence_margin", v).apply()
    /** aufeinanderfolgende klare Draußen-Messungen (lokale Zählung). */
    var outsideCount: Int
        get() = sp.getInt("outside_count", 0)
        set(v) = sp.edit().putInt("outside_count", v).apply()
    /** Laden-WLAN-Namen (SSID), mit "\n" getrennt. */
    var storeWifis: String
        get() = sp.getString("store_wifis", "") ?: ""
        set(v) = sp.edit().putString("store_wifis", v).apply()
    /** Zeitplan. */
    var schedEnabled: Boolean
        get() = sp.getBoolean("sched_on", false)
        set(v) = sp.edit().putBoolean("sched_on", v).apply()
    var schedFrom: String
        get() = sp.getString("sched_from", "08:00") ?: "08:00"
        set(v) = sp.edit().putString("sched_from", v).apply()
    var schedUntil: String
        get() = sp.getString("sched_until", "20:00") ?: "20:00"
        set(v) = sp.edit().putString("sched_until", v).apply()
    /** aktive Wochentage als CSV (0=Mo…6=So). */
    var schedDays: String
        get() = sp.getString("sched_days", "0,1,2,3,4,5") ?: "0,1,2,3,4,5"
        set(v) = sp.edit().putString("sched_days", v).apply()
    /** Entsperr-Passwort (gesalzener Hash) für Offline-Prüfung am Gerät. */
    var unlockSalt: String
        get() = sp.getString("unlock_salt", "") ?: ""
        set(v) = sp.edit().putString("unlock_salt", v).apply()
    var unlockHash: String
        get() = sp.getString("unlock_hash", "") ?: ""
        set(v) = sp.edit().putString("unlock_hash", v).apply()
    var unlockIter: Int
        get() = sp.getInt("unlock_iter", 120000)
        set(v) = sp.edit().putInt("unlock_iter", v).apply()
    /** Entsperren am Gerät erfolgt, muss noch an den Server gemeldet werden. */
    var pendingUnlock: Boolean
        get() = sp.getBoolean("pending_unlock", false)
        set(v) = sp.edit().putBoolean("pending_unlock", v).apply()
    /** bis zu diesem Zeitpunkt lokal NICHT erneut sperren (nach Entsperren am Gerät). */
    var noLockUntil: Long
        get() = sp.getLong("no_lock_until", 0)
        set(v) = sp.edit().putLong("no_lock_until", v).apply()
    /** Für welche Sperr-Nummer schon ein Diebstahl-Foto gemacht wurde (nur einmal pro Sperrung). */
    var photoSeq: Long
        get() = sp.getLong("photo_seq", -1)
        set(v) = sp.edit().putLong("photo_seq", v).apply()

    /** Über *#06# ausgelesene IMEI/Seriennummer (falls Android sie der App direkt nicht gibt). */
    var capturedImei: String
        get() = sp.getString("cap_imei", "") ?: ""
        set(v) = sp.edit().putString("cap_imei", v).apply()
    var capturedSerial: String
        get() = sp.getString("cap_serial", "") ?: ""
        set(v) = sp.edit().putString("cap_serial", v).apply()
    /** true = *#06#-Auslesen bei der Einrichtung schon einmal versucht. */
    var imeiTried: Boolean
        get() = sp.getBoolean("imei_tried", false)
        set(v) = sp.edit().putBoolean("imei_tried", v).apply()
}
