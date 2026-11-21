package de.retaildemo.demo

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.CancellationSignal
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Hintergrund-Dienst für den Diebstahlschutz: holt regelmäßig den Standort (GPS + Funknetz, ohne
 * Google-Dienste) und übergibt ihn an den [TheftGuard]. Läuft dauerhaft (Foreground-Service), damit
 * auch ein geklautes Gerät seinen Standort meldet, sobald es wieder Internet hat.
 */
class TheftService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null
    private val guard get() = demoApp.theft
    private val lm by lazy { getSystemService(Context.LOCATION_SERVICE) as LocationManager }

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) { guard.onLocation(location) }
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundSafe()
        requestLocationUpdates()
        if (job?.isActive != true) job = scope.launch { loop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private val providers = listOf(
        LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)

    private fun requestLocationUpdates() {
        if (!hasLocationPermission()) { Log.w(TAG, "Keine Standort-Berechtigung"); return }
        // Alle 30 s ein Update anfordern, minDistance 0 -> auch stillstehende Geräte (im Laden!) melden.
        val interval = 30_000L
        try {
            for (p in providers) {
                if (lm.allProviders.contains(p)) {
                    @Suppress("MissingPermission")
                    lm.requestLocationUpdates(p, interval, 0f, listener, Looper.getMainLooper())
                }
            }
        } catch (e: Exception) { Log.w(TAG, "Standortabfrage", e) }
        pushLastKnown()
        requestFreshFix()
    }

    /** Letzten bekannten Standort an den Guard geben (auch wenn er älter ist – besser als gar keiner). */
    private fun pushLastKnown() {
        if (!hasLocationPermission()) return
        try {
            @Suppress("MissingPermission")
            val last = providers
                .mapNotNull { if (lm.allProviders.contains(it)) lm.getLastKnownLocation(it) else null }
                .maxByOrNull { it.time }
            if (last != null) guard.onLocation(last)
        } catch (e: Exception) { Log.w(TAG, "LastKnown", e) }
    }

    /** Aktiv einen frischen Fix anstoßen (weckt GPS/Funknetz), damit nicht nur auf Bewegung gewartet wird. */
    private fun requestFreshFix() {
        if (!hasLocationPermission()) return
        try {
            for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                if (!lm.allProviders.contains(p)) continue
                if (Build.VERSION.SDK_INT >= 30) {
                    @Suppress("MissingPermission")
                    lm.getCurrentLocation(p, CancellationSignal(), mainExecutor) { loc -> if (loc != null) guard.onLocation(loc) }
                } else {
                    @Suppress("MissingPermission", "DEPRECATION")
                    lm.requestSingleUpdate(p, object : LocationListener {
                        override fun onLocationChanged(location: Location) { guard.onLocation(location) }
                        @Deprecated("Deprecated in Java")
                        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                        override fun onProviderEnabled(provider: String) {}
                        override fun onProviderDisabled(provider: String) {}
                    }, Looper.getMainLooper())
                }
            }
        } catch (e: Exception) { Log.w(TAG, "FreshFix", e) }
    }

    private suspend fun loop() {
        while (scope.isActive) {
            runCatching { pushLastKnown() }
            runCatching { requestFreshFix() }
            runCatching { guard.flush() }
            delay(60_000)
        }
    }

    private fun startForegroundSafe() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Geräteschutz", NotificationManager.IMPORTANCE_MIN).apply {
            setShowBadge(false)
            description = "Diebstahlschutz: meldet den Standort und schützt das Gerät."
        })
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle("Geräteschutz aktiv")
            .setContentText("Dieses Gerät ist durch den Diebstahlschutz überwacht.")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34)
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            else startForeground(NOTIF_ID, n)
        } catch (e: Exception) {
            Log.w(TAG, "Foreground-Service", e)
            try { startForeground(NOTIF_ID, n) } catch (_: Exception) {}
        }
    }

    override fun onDestroy() {
        try { lm.removeUpdates(listener) } catch (_: Exception) {}
        job?.cancel()
        // Nicht komplett sterben lassen – gleich neu starten (START_STICKY hilft zusätzlich).
        if (demoApp.prefs.isConfigured) ensureRunning(this)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "TheftService"
        private const val CHANNEL = "geraeteschutz"
        private const val NOTIF_ID = 42

        fun ensureRunning(ctx: Context) {
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, TheftService::class.java))
            } catch (e: Exception) { Log.w(TAG, "Start", e) }
        }
    }
}
