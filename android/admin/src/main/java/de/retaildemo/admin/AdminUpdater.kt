package de.retaildemo.admin

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import de.retaildemo.core.AppRelease
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/**
 * Updates der Admin-App über den eigenen Server: Auf der Webseite unter Einstellungen → App-Updates die
 * RetailDemo-Admin-….apk hochladen – die App prüft regelmäßig, meldet „Update verfügbar“ und installiert
 * auf Knopfdruck (Android fragt einmal nach).
 */
object AdminUpdater {
    private const val TAG = "AdminUpdater"
    private const val NOTIFY_ID = 900_001

    sealed interface State {
        data object Idle : State
        data object Checking : State
        data class Available(val release: AppRelease) : State
        data object UpToDate : State
        data class Downloading(val progress: Float) : State
        data object Installing : State
        data class Failed(val message: String) : State
    }

    val state = MutableStateFlow<State>(State.Idle)
    val installedCode get() = BuildConfig.VERSION_CODE
    val installedName: String get() = BuildConfig.VERSION_NAME

    private fun sp(ctx: Context) = ctx.getSharedPreferences("admin", 0)

    suspend fun check(ctx: Context): AppRelease? {
        val api = Alerts.api(ctx) ?: return null
        state.value = State.Checking
        return try {
            val r = api.adminAppRelease().takeIf { it.versionCode > installedCode }
            state.value = if (r != null) State.Available(r) else State.UpToDate
            r
        } catch (e: Exception) {
            state.value = State.Failed(e.message ?: "Server nicht erreichbar")
            null
        }
    }

    /** Im Hintergrund (alle paar Stunden): bei neuer Version einmal benachrichtigen. */
    suspend fun checkInBackground(ctx: Context) {
        val now = System.currentTimeMillis()
        if (now - sp(ctx).getLong("upd_checked", 0) < 3 * 3600_000L) return
        sp(ctx).edit().putLong("upd_checked", now).apply()
        val r = check(ctx) ?: return
        if (sp(ctx).getInt("upd_notified", 0) >= r.versionCode || !Alerts.canNotify(ctx)) return
        sp(ctx).edit().putInt("upd_notified", r.versionCode).apply()
        Alerts.channels(ctx)
        val open = PendingIntent.getActivity(ctx, NOTIFY_ID,
            Intent(ctx, AdminActivity::class.java).putExtra("open_settings", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(ctx).notify(NOTIFY_ID, NotificationCompat.Builder(ctx, Alerts.CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Admin-App-Update ${r.versionName} verfügbar")
            .setContentText("Antippen und unter Einstellungen → App-Version „Jetzt aktualisieren“ wählen.")
            .setColor(0xFFEE7F00.toInt())
            .setAutoCancel(true)
            .setContentIntent(open)
            .build())
    }

    fun canInstall(ctx: Context) = ctx.packageManager.canRequestPackageInstalls()

    suspend fun install(ctx: Context, r: AppRelease) {
        val api = Alerts.api(ctx) ?: return
        try {
            val apk = File(ctx.cacheDir, "admin-update.apk")
            state.value = State.Downloading(0f)
            api.download(r.url.ifBlank { "/api/admin/admin-app/apk" }, apk)
            if (r.sha256.isNotEmpty() && sha256(apk) != r.sha256) {
                apk.delete()
                error("Download beschädigt – bitte erneut versuchen")
            }
            state.value = State.Installing
            withContext(Dispatchers.IO) { commit(ctx, apk) }
        } catch (e: Exception) {
            Log.w(TAG, "Update fehlgeschlagen", e)
            state.value = State.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun commit(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("admin.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out, 256 * 1024) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pi = PendingIntent.getBroadcast(ctx, id, Intent(ctx, AdminUpdateReceiver::class.java), flags)
            session.commit(pi.intentSender)
        }
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
}

/** Ergebnis der Installation: Bestätigungsdialog von Android anzeigen bzw. Fehler melden. */
class AdminUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { context.startActivity(it) }
            }
            PackageInstaller.STATUS_SUCCESS -> AdminUpdater.state.value = AdminUpdater.State.UpToDate
            else -> AdminUpdater.state.value = AdminUpdater.State.Failed(
                if (status == PackageInstaller.STATUS_FAILURE_ABORTED) "Abgebrochen"
                else intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Fehler $status")
        }
    }
}
