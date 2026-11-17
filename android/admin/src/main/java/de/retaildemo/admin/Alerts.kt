package de.retaildemo.admin

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import de.retaildemo.core.Alert
import de.retaildemo.core.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * Push-Benachrichtigungen für Alarme vom Server (Gerät offline, 3D-Druck fertig/Fehler, Druckbett abräumen,
 * Speicher knapp, Backup fehlgeschlagen). Ohne Google-Dienste:
 * - Sofort: ein Dienst hält eine Verbindung zum Server offen (lange Abfrage, sehr wenig Akku/Daten)
 * - Absicherung: alle 15 Minuten nachsehen (WorkManager), falls Android den Dienst beendet hat
 */
object Alerts {
    const val CHANNEL_ALERTS = "alarme"
    const val CHANNEL_SERVICE = "verbindung"
    private const val TAG = "Alerts"

    private fun sp(ctx: Context) = ctx.getSharedPreferences("admin", 0)
    fun enabled(ctx: Context) = sp(ctx).getBoolean("push", true)
    fun instant(ctx: Context) = sp(ctx).getBoolean("push_instant", true)
    fun setEnabled(ctx: Context, on: Boolean, instant: Boolean) {
        sp(ctx).edit().putBoolean("push", on).putBoolean("push_instant", instant).apply()
        start(ctx)
    }

    fun api(ctx: Context): ApiClient? {
        val url = sp(ctx).getString("url", "") ?: ""
        val token = sp(ctx).getString("token", "") ?: ""
        return if (url.isBlank() || token.isBlank()) null else ApiClient(url, token)
    }

    fun lastId(ctx: Context) = sp(ctx).getLong("last_alert", -1)
    fun setLastId(ctx: Context, id: Long) = sp(ctx).edit().putLong("last_alert", id).apply()

    fun canNotify(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun channels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, "Alarme", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Gerät offline, 3D-Druck fertig, Druckbett abräumen, Speicher knapp …"
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "Verbindung zum Server", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Hält die Verbindung für sofortige Benachrichtigungen. Kann ausgeblendet werden."
            setShowBadge(false)
        })
    }

    /** Dienst bzw. Hintergrund-Abfrage passend zu den Einstellungen starten/stoppen. */
    fun start(ctx: Context) {
        channels(ctx)
        val wm = WorkManager.getInstance(ctx)
        val configured = api(ctx) != null
        if (enabled(ctx) && configured) {
            wm.enqueueUniquePeriodicWork("alerts", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<AlertWorker>(15, TimeUnit.MINUTES).build())
        } else wm.cancelUniqueWork("alerts")
        val svc = Intent(ctx, AlertService::class.java)
        if (enabled(ctx) && instant(ctx) && configured) {
            runCatching { ContextCompat.startForegroundService(ctx, svc) }.onFailure { Log.w(TAG, "Dienst nicht gestartet", it) }
        } else ctx.stopService(svc)
    }

    /** Neue Alarme holen und anzeigen. wait=true: bis zu 50 s auf neue warten. */
    suspend fun poll(ctx: Context, wait: Boolean) {
        val api = api(ctx) ?: return
        var last = lastId(ctx)
        if (last < 0) { // erster Start: alte Alarme nicht nachträglich melden
            setLastId(ctx, api.alerts(limit = 1).latestId)
            return
        }
        val list = if (wait) api.waitAlerts(last) else api.alerts(after = last, limit = 50)
        for (a in list.alerts.sortedBy { it.id }) {
            if (a.id <= last) continue
            if (!a.resolved && !a.acked) show(ctx, a)
            last = a.id
        }
        setLastId(ctx, maxOf(last, if (wait) list.latestId else last))
    }

    fun show(ctx: Context, a: Alert) {
        if (!canNotify(ctx)) return
        val open = PendingIntent.getActivity(ctx, a.id.toInt(),
            Intent(ctx, AdminActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(ctx, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(a.title)
            .setContentText(a.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(a.body))
            .setPriority(if (a.level == "info") NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .setColor(0xFFEE7F00.toInt())
            .setAutoCancel(true)
            .setContentIntent(open)
            .setWhen((a.t * 1000).toLong())
        if (a.action == "bed_clear") {
            val act = PendingIntent.getBroadcast(ctx, a.id.toInt(),
                Intent(ctx, AlertActionReceiver::class.java).setAction(AlertActionReceiver.BED_CLEAR).putExtra("id", a.id),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            b.addAction(0, "✓ Druckbett ist frei", act)
        }
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(ctx).notify(a.id.toInt(), b.build())
    }
}

/** Hält die Verbindung zum Server (lange Abfrage) und zeigt neue Alarme sofort. */
class AlertService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Alerts.channels(this)
        val n: Notification = NotificationCompat.Builder(this, Alerts.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Retail Demo: Benachrichtigungen aktiv")
            .setContentText("Alarme vom Server kommen sofort an. Diese Meldung lässt sich in den Einstellungen ausblenden.")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, AdminActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, n)
        if (job?.isActive != true) job = scope.launch {
            var backoff = 5_000L
            while (isActive) {
                try {
                    Alerts.poll(this@AlertService, wait = true)
                    backoff = 5_000L
                } catch (e: Exception) {
                    Log.w("AlertService", "Abfrage fehlgeschlagen", e)
                    delay(backoff)
                    backoff = (backoff * 2).coerceAtMost(120_000L)
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        job?.cancel()
        super.onDestroy()
    }
}

/** Absicherung: alle 15 Minuten nachsehen (falls der Dienst beendet wurde) und den Dienst wieder starten. */
class AlertWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        if (!Alerts.enabled(applicationContext)) return Result.success()
        runCatching { Alerts.poll(applicationContext, wait = false) }
        if (Alerts.instant(applicationContext)) runCatching { Alerts.start(applicationContext) }
        return Result.success()
    }
}

/** Knopf in der Benachrichtigung: „Druckbett ist frei“. */
class AlertActionReceiver : BroadcastReceiver() {
    companion object { const val BED_CLEAR = "de.retaildemo.admin.BED_CLEAR" }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != BED_CLEAR) return
        val id = intent.getLongExtra("id", 0)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                Alerts.api(context)?.bedClear()
                NotificationManagerCompat.from(context).cancel(id.toInt())
            } catch (e: Exception) {
                Log.w("AlertAction", "Druckbett frei melden fehlgeschlagen", e)
            } finally {
                pending.finish()
            }
        }
    }
}

/** Nach dem Neustart des Handys wieder verbinden. */
class AdminBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Alerts.start(context)
    }
}
