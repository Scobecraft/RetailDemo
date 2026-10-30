package de.retaildemo.demo

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.SystemClock
import android.util.Log
import de.retaildemo.core.ApiClient
import de.retaildemo.core.AppRelease
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/**
 * Aktualisiert die Demo-App auf die Version, die auf der Webseite unter "App-Updates" hochgeladen wurde.
 * Beim ersten Mal fragt Android nach; ab Android 12 laufen weitere Updates meist ohne Rückfrage
 * (die App ist dann selbst als Installationsquelle eingetragen).
 */
class AppUpdater(private val app: DemoApp) {

    sealed interface State {
        data object Idle : State
        data object Checking : State
        data class Result(val latest: AppRelease?, val error: String? = null) : State
        data class Downloading(val progress: Float) : State
        data object Installing : State
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state

    val installedCode get() = BuildConfig.VERSION_CODE
    val installedName: String get() = BuildConfig.VERSION_NAME

    fun isNewer(r: AppRelease?) = r != null && r.versionCode > installedCode

    private fun api() = ApiClient(app.prefs.serverUrl, app.prefs.deviceToken)

    suspend fun check(): AppRelease? {
        if (!app.prefs.isConfigured) return null
        _state.value = State.Checking
        return try {
            val r = api().appUpdate().takeIf { it.versionCode > 0 }
            _state.value = State.Result(r)
            r
        } catch (e: Exception) {
            _state.value = State.Result(null, e.message ?: "Server nicht erreichbar")
            null
        }
    }

    fun canInstall() = app.packageManager.canRequestPackageInstalls()

    /** Lädt die neue Version und startet die Installation. */
    suspend fun install(release: AppRelease) {
        try {
            val apk = File(app.cacheDir, "update.apk")
            _state.value = State.Downloading(0f)
            api().download(release.url, apk)
            if (release.sha256.isNotEmpty() && sha256(apk) != release.sha256) {
                apk.delete()
                error("Download beschädigt – bitte erneut versuchen")
            }
            _state.value = State.Installing
            // Während der Installation die Demo nicht dazwischenschieben
            app.updateInProgressUntil = SystemClock.elapsedRealtime() + 5 * 60_000
            withContext(Dispatchers.IO) { commit(apk) }
        } catch (e: Exception) {
            Log.w(TAG, "Update fehlgeschlagen", e)
            app.updateInProgressUntil = 0
            _state.value = State.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun commit(apk: File) {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(app.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("demo.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out, 256 * 1024) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pi = PendingIntent.getBroadcast(app, id, Intent(app, UpdateResultReceiver::class.java), flags)
            session.commit(pi.intentSender)
        }
    }

    internal fun onFailed(message: String) {
        app.updateInProgressUntil = 0
        _state.value = State.Failed(message)
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

    companion object { const val TAG = "DemoUpdate" }
}

/** Rückmeldung von Android zur Installation. */
class UpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Android möchte eine Bestätigung ("Aktualisieren")
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { context.startActivity(it) }
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i(AppUpdater.TAG, "Update installiert")
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Fehler $status"
                Log.w(AppUpdater.TAG, "Update fehlgeschlagen: $msg")
                context.demoApp.updater.onFailed(
                    if (status == PackageInstaller.STATUS_FAILURE_ABORTED) "Abgebrochen" else msg
                )
            }
        }
    }
}
