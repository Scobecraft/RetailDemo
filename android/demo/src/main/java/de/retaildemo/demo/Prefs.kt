package de.retaildemo.demo

import android.content.Context
import de.retaildemo.core.ApiClient
import de.retaildemo.core.Manifest
import java.util.UUID

/** Lokale Einstellungen des Demo-Geräts. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("demo", Context.MODE_PRIVATE)

    val deviceId: String
        get() = sp.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            sp.edit().putString("device_id", it).apply()
        }

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
