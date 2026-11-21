package de.retaildemo.demo

import android.content.Intent
import android.location.Location
import android.util.Log
import de.retaildemo.core.ApiClient
import de.retaildemo.core.LocFix
import de.retaildemo.core.LocationReport
import de.retaildemo.core.TheftInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Diebstahlschutz: Der Guard bekommt Standorte (von [TheftService]), meldet sie an den Server (auch
 * verspätet, wenn gerade kein Internet da war) und prüft selbst den erlaubten Bereich (Geofence) –
 * das funktioniert auch komplett offline. Verlässt das Gerät den Bereich dauerhaft, wird es gesperrt
 * (Alarm + Sperrbildschirm). Entsperrt wird NUR über den Server (Webseite).
 *
 * Fehlalarm-Schutz: nur genaue GPS-Messungen zählen, ein Puffer um den Radius, und das Gerät muss den
 * Bereich eine Weile DURCHGEHEND verlassen haben. Kein Standort = kein Alarm.
 */
class TheftGuard(private val app: DemoApp) {
    private val prefs get() = app.prefs
    private val queueFile = File(app.filesDir, "loc-queue.jsonl")
    private val sendMutex = Mutex()
    /** true = Sperrbildschirm/Alarm sollen laufen. */
    val locked = MutableStateFlow(prefs.theftLocked)

    private fun api() = ApiClient(prefs.serverUrl, prefs.deviceToken)

    companion object {
        private const val TAG = "TheftGuard"
        fun distanceM(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
            val r = 6371000.0
            val p1 = Math.toRadians(aLat); val p2 = Math.toRadians(bLat)
            val dp = Math.toRadians(bLat - aLat); val dl = Math.toRadians(bLon - aLon)
            val h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
            return 2 * r * asin(min(1.0, sqrt(h)))
        }
    }

    /** Beim App-Start: falls laut Prefs gesperrt, Sperre sofort wieder aktiv (überlebt Neustart). */
    fun init() {
        if (prefs.theftLocked) applyLockState(true, prefs.theftLockReason)
    }

    // ---------------------------------------------------------- Server-Stand übernehmen
    /** Aus Heartbeat/Sync/Standort-Antwort: Geofence zwischenspeichern und Sperrbefehl befolgen. */
    fun applyServerState(t: TheftInfo?) {
        t ?: return
        // Geofence-Daten für die eigene (Offline-)Prüfung merken
        val wasArmed = prefs.theftArmed
        prefs.theftArmed = t.armed
        prefs.fenceHasCenter = t.geofence.enabled && t.geofence.lat != null && t.geofence.lon != null
        if (prefs.fenceHasCenter) {
            prefs.fenceLat = t.geofence.lat!!; prefs.fenceLon = t.geofence.lon!!
            prefs.fenceRadiusM = t.geofence.radiusM
        }
        prefs.fenceMinAcc = t.params.minAccuracyM
        prefs.fenceDwellS = t.params.dwellS
        prefs.fenceGraceS = t.params.armGraceS
        prefs.fenceReportS = t.params.reportIntervalS
        if (t.armed && !wasArmed) { prefs.armedAt = System.currentTimeMillis(); prefs.outsideSince = 0 }

        // Server-Sperrbefehl: nur bei NEUERER Nummer übernehmen (so entsperrt die Webseite zuverlässig)
        if (t.lockSeq > prefs.theftLockSeq) {
            prefs.theftLockSeq = t.lockSeq
            if (t.locked) {
                prefs.theftLockReason = t.lockReason.ifBlank { "Außerhalb des erlaubten Bereichs" }
                applyLockState(true, prefs.theftLockReason)
            } else {
                applyLockState(false, "")
            }
        }
    }

    private fun applyLockState(lock: Boolean, reason: String) {
        prefs.theftLocked = lock
        prefs.theftLockReason = reason
        locked.value = lock
        if (lock) {
            try {
                app.startActivity(Intent(app, TheftLockActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            } catch (e: Exception) { Log.w(TAG, "Sperrbildschirm", e) }
            TheftService.ensureRunning(app)
        }
        // Alarm/Entsperren erledigt TheftLockActivity selbst über den locked-Flow.
    }

    /** true = testweise ausgelöst (Sperrbildschirm zeigt dann einen TEST-Hinweis). */
    val isTest get() = prefs.theftLockReason.startsWith("Test")

    // ---------------------------------------------------------- neuer Standort
    private var lastFixKey: String? = null

    fun onLocation(loc: Location) {
        val fix = LocFix(
            t = loc.time / 1000.0,
            lat = loc.latitude, lon = loc.longitude,
            acc = if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0,
            battery = DeviceInfo.batteryPercent(app),
            speed = if (loc.hasSpeed()) loc.speed.toDouble() else null,
            source = loc.provider ?: "gps",
        )
        // Denselben Standort (z. B. wiederholt gelesener "letzter bekannter") nicht doppelt ans Netz senden,
        // die Geofence-Prüfung läuft aber trotzdem weiter (Verweildauer).
        val key = "${loc.time}:${loc.latitude}:${loc.longitude}"
        if (key != lastFixKey) { lastFixKey = key; enqueue(fix) }
        checkGeofenceLocally(fix)
    }

    /** Eigene Geofence-Prüfung – wirkt auch ohne Internet. Gleiche Fehlalarm-Regeln wie der Server. */
    private fun checkGeofenceLocally(fix: LocFix) {
        if (prefs.theftLocked || !prefs.theftArmed || !prefs.fenceHasCenter) return
        val now = System.currentTimeMillis()
        if (prefs.armedAt > 0 && now - prefs.armedAt < prefs.fenceGraceS * 1000L) return  // Schonzeit
        val goodAcc = fix.acc <= 0.0 || fix.acc <= prefs.fenceMinAcc
        if (!goodAcc) return  // ungenaue Messung ignorieren
        val dist = distanceM(prefs.fenceLat, prefs.fenceLon, fix.lat, fix.lon)
        val buffer = maxOf(fix.acc, 30.0)
        when {
            dist > prefs.fenceRadiusM + buffer -> {  // eindeutig draußen
                if (prefs.outsideSince == 0L) prefs.outsideSince = now
                if (now - prefs.outsideSince >= prefs.fenceDwellS * 1000L) {
                    prefs.theftLockReason = "Bereich verlassen (${dist.toInt()} m vom Laden)"
                    applyLockState(true, prefs.theftLockReason)
                    // Server gleich informieren (löst dort den Push-Alarm aus)
                    app.scope.launch { runCatching { flush(force = true) } }
                }
            }
            dist <= prefs.fenceRadiusM -> prefs.outsideSince = 0L  // eindeutig drinnen
        }
    }

    // ---------------------------------------------------------- Melden (mit Offline-Warteschlange)
    private fun enqueue(fix: LocFix) {
        synchronized(queueFile) {
            runCatching {
                if (queueFile.length() > 400_000) trimQueue()
                queueFile.appendText(ApiClient.JSON.encodeToString(LocFix.serializer(), fix) + "\n")
            }
        }
    }

    private fun trimQueue() {
        val lines = runCatching { queueFile.readLines() }.getOrDefault(emptyList())
        queueFile.writeText(lines.takeLast(300).joinToString("\n", postfix = "\n"))
    }

    /** Warteschlange an den Server senden. force=true: auch wenn das Intervall noch nicht um ist. */
    suspend fun flush(force: Boolean = false) {
        if (!prefs.isConfigured) return
        val now = System.currentTimeMillis()
        if (!force && now - prefs.lastLocReport < prefs.fenceReportS * 1000L) return
        sendMutex.withLock {
            val lines = synchronized(queueFile) {
                if (!queueFile.exists()) return@withLock
                val l = runCatching { queueFile.readLines() }.getOrDefault(emptyList())
                queueFile.delete()
                l
            }
            val fixes = lines.mapNotNull { runCatching { ApiClient.JSON.decodeFromString(LocFix.serializer(), it) }.getOrNull() }
            if (fixes.isEmpty()) return@withLock
            try {
                val status = api().postLocation(LocationReport(
                    deviceId = prefs.deviceId, fixes = fixes.takeLast(200),
                    appOutside = prefs.outsideSince > 0, appLocked = prefs.theftLocked))
                prefs.lastLocReport = now
                applyServerState(status)
            } catch (e: Exception) {
                Log.w(TAG, "Standort senden fehlgeschlagen – später erneut", e)
                synchronized(queueFile) {
                    val keep = (lines + runCatching { if (queueFile.exists()) queueFile.readLines() else emptyList() }.getOrDefault(emptyList())).takeLast(300)
                    queueFile.writeText(keep.joinToString("\n", postfix = "\n"))
                }
            }
        }
    }
}
