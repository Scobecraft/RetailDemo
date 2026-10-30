package de.retaildemo.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

class ApiException(val code: Int, message: String) : IOException(message)

/** Spricht mit dem Retail-Demo-Server. [token] ist das Admin- oder Geräte-Token. */
class ApiClient(baseUrl: String, private val token: String) {

    val baseUrl: String = normalizeUrl(baseUrl)

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val req = chain.request()
            if (req.url.toString().startsWith(this.baseUrl)) {
                chain.proceed(req.newBuilder().header("Authorization", "Bearer $token").build())
            } else chain.proceed(req)
        }
        .build()

    fun url(path: String) = if (path.startsWith("http")) path else baseUrl + path

    // ---------------------------------------------------------------- low level
    private suspend fun call(method: String, path: String, body: RequestBody? = null): String =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(url(path)).method(method, body).build()
            http.newCall(req).execute().use { resp -> checked(resp).body!!.string() }
        }

    private fun checked(resp: Response): Response {
        if (!resp.isSuccessful) {
            val msg = when (resp.code) {
                401 -> "Token ungültig"
                404 -> "Nicht gefunden"
                else -> resp.body?.string()?.take(200) ?: ""
            }
            throw ApiException(resp.code, "Server-Fehler ${resp.code}: $msg")
        }
        return resp
    }

    private inline fun <reified T> jsonBody(value: T): RequestBody =
        JSON.encodeToString(value).toRequestBody(JSON_TYPE)

    // ----------------------------------------------------------------- general
    suspend fun health(): Boolean = call("GET", "/api/health").contains("ok")

    // ------------------------------------------------------------------- admin
    suspend fun media(): List<MediaItem> = JSON.decodeFromString(call("GET", "/api/admin/media"))

    suspend fun uploadMedia(
        fileName: String,
        mime: String,
        length: Long,
        open: () -> InputStream,
        onProgress: (Float) -> Unit,
    ): MediaItem {
        val fileBody = StreamingBody(mime.toMediaType(), length, open, onProgress)
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, fileBody)
            .build()
        return JSON.decodeFromString(call("POST", "/api/admin/media", multipart))
    }

    suspend fun updateMedia(id: String, title: String? = null, durationS: Int? = null): MediaItem {
        val map = buildMap {
            title?.let { put("title", kotlinx.serialization.json.JsonPrimitive(it)) }
            durationS?.let { put("duration_s", kotlinx.serialization.json.JsonPrimitive(it)) }
        }
        val body = kotlinx.serialization.json.JsonObject(map).toString().toRequestBody(JSON_TYPE)
        return JSON.decodeFromString(call("PATCH", "/api/admin/media/$id", body))
    }

    suspend fun deleteMedia(id: String) { call("DELETE", "/api/admin/media/$id") }

    fun thumbUrl(id: String) = url("/api/media/$id/thumb")
    fun fileUrl(id: String) = url("/api/media/$id/file")

    suspend fun playlists(): List<Playlist> = JSON.decodeFromString(call("GET", "/api/admin/playlists"))
    suspend fun createPlaylist(body: PlaylistBody): Playlist =
        JSON.decodeFromString(call("POST", "/api/admin/playlists", jsonBody(body)))
    suspend fun updatePlaylist(id: Int, body: PlaylistBody): Playlist =
        JSON.decodeFromString(call("PUT", "/api/admin/playlists/$id", jsonBody(body)))
    suspend fun deletePlaylist(id: Int) { call("DELETE", "/api/admin/playlists/$id") }

    suspend fun devices(): List<Device> = JSON.decodeFromString(call("GET", "/api/admin/devices"))
    suspend fun updateDevice(id: String, patch: DevicePatch): Device =
        JSON.decodeFromString(call("PATCH", "/api/admin/devices/$id", jsonBody(patch)))
    suspend fun deleteDevice(id: String) { call("DELETE", "/api/admin/devices/$id") }
    suspend fun syncNow(id: String) { call("POST", "/api/admin/devices/$id/sync-now", EMPTY) }
    suspend fun syncAll() { call("POST", "/api/admin/devices/sync-all", EMPTY) }

    suspend fun settings(): ServerSettings = JSON.decodeFromString(call("GET", "/api/admin/settings"))
    suspend fun saveSettings(s: ServerSettings): ServerSettings =
        JSON.decodeFromString(call("PUT", "/api/admin/settings", jsonBody(s.copy(logo = null))))

    /** Laden-Logo für die Laptop-Demo hochladen. */
    suspend fun uploadLogo(fileName: String, mime: String, bytes: ByteArray) {
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, bytes.toRequestBody(mime.toMediaType()))
            .build()
        call("POST", "/api/admin/logo", multipart)
    }

    suspend fun deleteLogo() { call("DELETE", "/api/admin/logo") }

    fun logoUrl(sha256: String) = url("/api/logo?v=${sha256.take(8)}")

    // ------------------------------------------------------------------ device
    suspend fun sync(report: DeviceReport): Manifest =
        JSON.decodeFromString(call("POST", "/api/device/sync", jsonBody(report)))

    suspend fun heartbeat(report: DeviceReport): HeartbeatResponse =
        JSON.decodeFromString(call("POST", "/api/device/heartbeat", jsonBody(report)))

    suspend fun appUpdate(): AppRelease = JSON.decodeFromString(call("GET", "/api/device/app-update"))

    suspend fun unregister(deviceId: String) {
        call("POST", "/api/device/unregister", """{"device_id":${kotlinx.serialization.json.JsonPrimitive(deviceId)}}""".toRequestBody(JSON_TYPE))
    }

    /** Lädt [path] nach [dest] herunter (über eine .part-Datei, damit nie halbe Dateien abgespielt werden). */
    suspend fun download(path: String, dest: File) = withContext(Dispatchers.IO) {
        val part = File(dest.parentFile, dest.name + ".part")
        val req = Request.Builder().url(url(path)).build()
        http.newCall(req).execute().use { resp ->
            checked(resp)
            part.outputStream().use { out -> resp.body!!.byteStream().copyTo(out, 256 * 1024) }
        }
        if (!part.renameTo(dest)) throw IOException("Konnte ${dest.name} nicht speichern")
    }

    companion object {
        val JSON = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
        private val JSON_TYPE = "application/json".toMediaType()
        private val EMPTY = ByteArray(0).toRequestBody(null)

        fun normalizeUrl(input: String): String {
            var u = input.trim().trimEnd('/')
            if (u.isNotEmpty() && !u.startsWith("http://") && !u.startsWith("https://")) u = "http://$u"
            return u
        }
    }
}

private class StreamingBody(
    private val type: MediaType,
    private val length: Long,
    private val open: () -> InputStream,
    private val onProgress: (Float) -> Unit,
) : RequestBody() {
    override fun contentType() = type
    override fun contentLength() = length
    override fun writeTo(sink: BufferedSink) {
        open().source().use { src ->
            var total = 0L
            val buf = okio.Buffer()
            while (true) {
                val read = src.read(buf, 256 * 1024)
                if (read == -1L) break
                sink.write(buf, read)
                total += read
                if (length > 0) onProgress(total.toFloat() / length)
            }
        }
    }
}
