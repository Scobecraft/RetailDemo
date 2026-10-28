package de.retaildemo.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class Spec(val label: String = "", val value: String = "")

@Serializable
data class MediaItem(
    val id: String,
    val title: String,
    val type: String,
    val mime: String = "",
    val size: Long = 0,
    val sha256: String = "",
    @SerialName("duration_s") val durationS: Int? = null,
    @SerialName("created_at") val createdAt: Double = 0.0,
) {
    val isVideo get() = type == "video"
}

@Serializable
data class Playlist(
    val id: Int,
    val name: String,
    @SerialName("is_default") val isDefault: Boolean = false,
    @SerialName("show_specs") val showSpecs: Boolean = true,
    @SerialName("media_ids") val mediaIds: List<String> = emptyList(),
)

@Serializable
data class PlaylistBody(
    val name: String? = null,
    @SerialName("media_ids") val mediaIds: List<String>? = null,
    @SerialName("is_default") val isDefault: Boolean? = null,
    @SerialName("show_specs") val showSpecs: Boolean? = null,
)

@Serializable
data class Device(
    val id: String,
    @SerialName("display_name") val displayName: String = "",
    @SerialName("effective_name") val effectiveName: String = "",
    val manufacturer: String? = null,
    val model: String? = null,
    @SerialName("marketing_name") val marketingName: String? = null,
    @SerialName("android_version") val androidVersion: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
    @SerialName("auto_specs") val autoSpecs: List<Spec> = emptyList(),
    @SerialName("custom_specs") val customSpecs: String = "",
    @SerialName("show_specs") val showSpecs: Boolean = true,
    @SerialName("playlist_id") val playlistId: Int? = null,
    @SerialName("playlist_name") val playlistName: String = "",
    val status: String? = null,
    @SerialName("last_error") val lastError: String? = null,
    val battery: Int? = null,
    val ip: String? = null,
    val online: Boolean = false,
    @SerialName("up_to_date") val upToDate: Boolean = false,
    @SerialName("sync_requested") val syncRequested: Boolean = false,
    @SerialName("last_seen") val lastSeen: Double? = null,
    @SerialName("last_sync") val lastSync: Double? = null,
)

@Serializable
data class DevicePatch(
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("custom_specs") val customSpecs: String? = null,
    @SerialName("show_specs") val showSpecs: Boolean? = null,
    @SerialName("playlist_id") val playlistId: Int? = null,
    @SerialName("clear_playlist") val clearPlaylist: Boolean = false,
)

@Serializable
data class DaySchedule(
    val active: Boolean = true,
    val on: String = "09:00",
    val off: String = "20:00",
)

/** Betriebszeiten: Index 0 = Montag … 6 = Sonntag. */
@Serializable
data class Schedule(
    val enabled: Boolean = false,
    val days: List<DaySchedule> = List(7) { DaySchedule(active = it < 6) },
)

@Serializable
data class ServerSettings(
    @SerialName("sync_interval_min") val syncIntervalMin: Int = 60,
    @SerialName("idle_timeout_s") val idleTimeoutS: Int = 30,
    @SerialName("specs_every_n") val specsEveryN: Int = 3,
    @SerialName("specs_duration_s") val specsDurationS: Int = 10,
    @SerialName("image_duration_s") val imageDurationS: Int = 8,
    @SerialName("cleanup_interval_h") val cleanupIntervalH: Int = 2,
    val schedule: Schedule = Schedule(),
)

@Serializable
data class ManifestItem(
    val id: String,
    val type: String,
    val mime: String = "",
    val size: Long = 0,
    val sha256: String = "",
    @SerialName("duration_s") val durationS: Int = 8,
    val url: String,
) {
    val isVideo get() = type == "video"
}

@Serializable
data class Manifest(
    val hash: String = "",
    @SerialName("playlist_name") val playlistName: String = "",
    val items: List<ManifestItem> = emptyList(),
    @SerialName("display_name") val displayName: String = "",
    val manufacturer: String = "",
    val specs: List<Spec> = emptyList(),
    @SerialName("show_specs") val showSpecs: Boolean = true,
    @SerialName("specs_every_n") val specsEveryN: Int = 3,
    @SerialName("specs_duration_s") val specsDurationS: Int = 10,
    @SerialName("sync_interval_min") val syncIntervalMin: Int = 60,
    @SerialName("idle_timeout_s") val idleTimeoutS: Int = 30,
    val schedule: Schedule = Schedule(),
    @SerialName("cleanup_interval_h") val cleanupIntervalH: Int = 2,
    @SerialName("heartbeat_interval_s") val heartbeatIntervalS: Int = 300,
)

@Serializable
data class DeviceReport(
    @SerialName("device_id") val deviceId: String,
    val manufacturer: String = "",
    val model: String = "",
    @SerialName("marketing_name") val marketingName: String = "",
    @SerialName("android_version") val androidVersion: String = "",
    @SerialName("app_version") val appVersion: String = "",
    val specs: List<Spec> = emptyList(),
    @SerialName("synced_hash") val syncedHash: String? = null,
    val status: String? = null,
    val error: String? = null,
    val battery: Int? = null,
    @SerialName("previous_id") val previousId: String? = null,
)

@Serializable
data class HeartbeatResponse(
    @SerialName("sync_now") val syncNow: Boolean = false,
    @SerialName("heartbeat_interval_s") val heartbeatIntervalS: Int = 300,
)
