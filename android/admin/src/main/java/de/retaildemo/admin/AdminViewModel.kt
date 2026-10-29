package de.retaildemo.admin

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import coil.ImageLoader
import de.retaildemo.core.ApiClient
import de.retaildemo.core.Device
import de.retaildemo.core.DevicePatch
import de.retaildemo.core.MediaItem
import de.retaildemo.core.Playlist
import de.retaildemo.core.PlaylistBody
import de.retaildemo.core.ServerSettings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class Upload(val key: Long, val name: String, val progress: Float = 0f, val error: String? = null)

class AdminViewModel(app: Application) : AndroidViewModel(app) {

    private val sp = app.getSharedPreferences("admin", 0)
    var serverUrl: String = sp.getString("url", "") ?: ""
        private set
    var adminToken: String = sp.getString("token", "") ?: ""
        private set
    val isConfigured get() = serverUrl.isNotBlank() && adminToken.isNotBlank()

    var api = ApiClient(serverUrl, adminToken)
        private set
    var imageLoader: ImageLoader = buildLoader()
        private set

    val media = MutableStateFlow<List<MediaItem>>(emptyList())
    val playlists = MutableStateFlow<List<Playlist>>(emptyList())
    val devices = MutableStateFlow<List<Device>>(emptyList())
    val settings = MutableStateFlow(ServerSettings())
    val uploads = MutableStateFlow<List<Upload>>(emptyList())
    val loading = MutableStateFlow(false)
    /** Einmalige Meldungen für die Snackbar. */
    val messages = MutableStateFlow<String?>(null)

    init { if (isConfigured) refreshAll() }

    private fun buildLoader() = ImageLoader.Builder(getApplication()).okHttpClient(api.http).crossfade(true).build()

    private fun launchSafe(block: suspend () -> Unit) = viewModelScope.launch {
        try { block() } catch (e: Exception) { messages.value = e.message ?: e.javaClass.simpleName }
    }

    /** Verbindung testen und speichern. Gibt null bei Erfolg zurück, sonst Fehlertext. */
    suspend fun connect(url: String, token: String): String? {
        val test = ApiClient(url, token.trim())
        return try {
            test.health()
            test.settings() // prüft das Admin-Token
            serverUrl = test.baseUrl
            adminToken = token.trim()
            sp.edit().putString("url", serverUrl).putString("token", adminToken).apply()
            api = test
            imageLoader = buildLoader()
            refreshAll()
            null
        } catch (e: Exception) {
            e.message ?: e.javaClass.simpleName
        }
    }

    fun refreshAll() = launchSafe {
        loading.value = true
        try {
            media.value = api.media()
            playlists.value = api.playlists()
            devices.value = api.devices()
            settings.value = api.settings()
        } finally {
            loading.value = false
        }
    }

    fun refreshDevices() = launchSafe { devices.value = api.devices() }

    // ------------------------------------------------------------------ media
    fun upload(uris: List<Uri>) = viewModelScope.launch {
        val cr = getApplication<Application>().contentResolver
        val jobs = uris.map { uri ->
            var name = "datei"
            var size = -1L
            cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    name = c.getString(0) ?: name
                    if (!c.isNull(1)) size = c.getLong(1).takeIf { it > 0 } ?: -1
                }
            }
            Triple(uri, Upload(System.nanoTime(), name), size)
        }
        uploads.update { it + jobs.map { j -> j.second } }
        for ((uri, up, size) in jobs) {
            try {
                val mime = cr.getType(uri) ?: "application/octet-stream"
                val item = api.uploadMedia(up.name, mime, size, { cr.openInputStream(uri)!! }) { p ->
                    uploads.update { list -> list.map { if (it.key == up.key) it.copy(progress = p) else it } }
                }
                media.update { listOf(item) + it }
                uploads.update { list -> list.filterNot { it.key == up.key } }
            } catch (e: Exception) {
                uploads.update { list ->
                    list.map { if (it.key == up.key) it.copy(error = e.message ?: "Fehler") else it }
                }
            }
        }
    }

    fun dismissUpload(key: Long) = uploads.update { list -> list.filterNot { it.key == key } }

    fun updateMedia(id: String, title: String?, durationS: Int?) = launchSafe {
        val updated = api.updateMedia(id, title, durationS)
        media.update { list -> list.map { if (it.id == id) updated else it } }
    }

    fun deleteMedia(id: String) = launchSafe {
        api.deleteMedia(id)
        media.update { list -> list.filterNot { it.id == id } }
        playlists.value = api.playlists()
    }

    // -------------------------------------------------------------- playlists
    fun createPlaylist(name: String) = launchSafe {
        api.createPlaylist(PlaylistBody(name = name))
        playlists.value = api.playlists()
    }

    fun savePlaylist(id: Int, body: PlaylistBody) = launchSafe {
        api.updatePlaylist(id, body)
        playlists.value = api.playlists() // "Standard" kann sich bei anderen geändert haben
        messages.value = "Gespeichert – Geräte übernehmen es beim nächsten Abgleich"
    }

    fun deletePlaylist(id: Int) = launchSafe {
        api.deletePlaylist(id)
        playlists.value = api.playlists()
        devices.value = api.devices()
    }

    // ---------------------------------------------------------------- devices
    fun updateDevice(id: String, patch: DevicePatch) = launchSafe {
        val d = api.updateDevice(id, patch)
        devices.update { list -> list.map { if (it.id == id) d else it } }
    }

    fun syncNow(id: String) = launchSafe {
        api.syncNow(id)
        messages.value = "Gerät aktualisiert sich innerhalb von ca. 5 Minuten"
        refreshDevices()
    }

    fun syncAll() = launchSafe {
        api.syncAll()
        messages.value = "Alle Geräte aktualisieren sich innerhalb von ca. 5 Minuten"
        refreshDevices()
    }

    fun deleteDevice(id: String) = launchSafe {
        api.deleteDevice(id)
        devices.update { list -> list.filterNot { it.id == id } }
    }

    // --------------------------------------------------------------- settings
    fun saveSettings(s: ServerSettings) = launchSafe {
        settings.value = api.saveSettings(s)
        messages.value = "Einstellungen gespeichert"
    }

    fun uploadLogo(uri: Uri) = launchSafe {
        val cr = getApplication<Application>().contentResolver
        var name = "logo.png"
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) name = c.getString(0) ?: name
        }
        val bytes = cr.openInputStream(uri)!!.use { it.readBytes() }
        api.uploadLogo(name, cr.getType(uri) ?: "image/png", bytes)
        settings.value = api.settings()
        messages.value = "Logo gespeichert – Laptops zeigen es nach dem nächsten Abgleich"
    }

    fun deleteLogo() = launchSafe {
        api.deleteLogo()
        settings.value = api.settings()
    }
}
