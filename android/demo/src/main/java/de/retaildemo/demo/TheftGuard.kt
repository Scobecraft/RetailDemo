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
    /** Entsperr-Passwort nur im Speicher halten, bis es (online) an den Server gemeldet wurde. */
    @Volatile private var pendingUnlockPw: String? = null

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
        prefs.fenceGpsOnly = t.params.gpsOnly
        prefs.fenceMinFixes = t.params.minFixes
        prefs.fenceMarginM = t.params.marginM
        prefs.storeWifis = t.wifiSsids.joinToString("\n")
        prefs.schedEnabled = t.schedule.enabled
        prefs.schedFrom = t.schedule.from
        prefs.schedUntil = t.schedule.until
        prefs.schedDays = t.schedule.days.joinToString(",")
        t.unlock?.let { prefs.unlockSalt = it.salt; prefs.unlockHash = it.hash; prefs.unlockIter = it.iter }
        if (t.armed && !wasArmed) { prefs.armedAt = System.currentTimeMillis(); prefs.outsideSince = 0; prefs.outsideCount = 0 }

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

    /** Eigene Geofence-Prüfung – wirkt auch ohne Internet. Strenge Regeln gegen Fehlalarme:
     *  Alarm NUR wenn Zeitplan scharf, NICHT im Laden-WLAN, und mehrere genaue GPS-Fixes klar draußen. */
    private fun checkGeofenceLocally(fix: LocFix) {
        if (prefs.theftLocked || !prefs.theftArmed || !prefs.fenceHasCenter) return
        val now = System.currentTimeMillis()
        if (now < prefs.noLockUntil) return                                   // kurz nach Entsperren am Gerät
        if (!scheduleActiveLocal()) { prefs.outsideSince = 0; prefs.outsideCount = 0; return }  // Zeitplan aus
        if (onStoreWifi()) { prefs.outsideSince = 0; prefs.outsideCount = 0; return }           // im Laden-WLAN
        if (prefs.armedAt > 0 && now - prefs.armedAt < prefs.fenceGraceS * 1000L) return        // Schonzeit
        // Nur verlässliche GPS-Messungen zählen
        if (fix.acc <= 0.0 || fix.acc > prefs.fenceMinAcc) return
        if (prefs.fenceGpsOnly && fix.source != "gps") return
        val dist = distanceM(prefs.fenceLat, prefs.fenceLon, fix.lat, fix.lon)
        val buffer = maxOf(fix.acc, 30.0) + prefs.fenceMarginM
        when {
            dist > prefs.fenceRadiusM + buffer -> {              // klar + sicher draußen
                if (prefs.outsideCount == 0 || prefs.outsideSince == 0L) { prefs.outsideSince = now; prefs.outsideCount = 0 }
                prefs.outsideCount = prefs.outsideCount + 1
                if (prefs.outsideCount >= prefs.fenceMinFixes &&
                    now - prefs.outsideSince >= prefs.fenceDwellS * 1000L) {
                    prefs.theftLockReason = "Bereich verlassen (${dist.toInt()} m vom Laden)"
                    applyLockState(true, prefs.theftLockReason)
                    app.scope.launch { runCatching { flush(force = true) } }
                }
            }
            dist <= prefs.fenceRadiusM -> { prefs.outsideSince = 0L; prefs.outsideCount = 0 }  // eindeutig drinnen
        }
    }

    /** Aktuell verbundenes WLAN gehört zum Laden? (SSID-Vergleich, Groß/Klein egal.) */
    private fun onStoreWifi(): Boolean {
        val list = prefs.storeWifis.split("\n").map { it.trim().trim('"').lowercase() }.filter { it.isNotEmpty() }
        if (list.isEmpty()) return false
        val ssid = currentSsid()?.trim()?.trim('"')?.lowercase() ?: return false
        if (ssid.isEmpty() || ssid == "<unknown ssid>") return false
        return list.contains(ssid)
    }

    private fun currentSsid(): String? {
        return try {
            val wm = app.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
            @Suppress("DEPRECATION")
            val info = wm?.connectionInfo ?: return null
            @Suppress("DEPRECATION")
            if (info.networkId == -1 && (info.ssid == null || info.ssid.contains("unknown"))) null else info.ssid
        } catch (e: Exception) { null }
    }

    /** Schutz laut Zeitplan gerade scharf? (lokale Gerätezeit) */
    private fun scheduleActiveLocal(): Boolean {
        if (!prefs.schedEnabled) return true
        val cal = java.util.Calendar.getInstance()
        // Calendar: SUNDAY=1..SATURDAY=7  ->  0=Mo..6=So
        val dow = (cal.get(java.util.Calendar.DAY_OF_WEEK) + 5) % 7
        val days = prefs.schedDays.split(",").mapNotNull { it.trim().toIntOrNull() }
        if (days.isNotEmpty() && !days.contains(dow)) return false
        fun mins(hhmm: String, def: Int): Int = hhmm.split(":").let {
            if (it.size == 2) (it[0].toIntOrNull() ?: 0) * 60 + (it[1].toIntOrNull() ?: 0) else def
        }
        val start = mins(prefs.schedFrom, 480); val end = mins(prefs.schedUntil, 1200)
        val cur = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE)
        if (start == end) return true
        return if (start < end) cur in start until end else (cur >= start || cur < end)
    }

    /** Entsperren am Gerät mit dem Admin-Passwort. Prüft offline gegen den gespeicherten Hash. */
    fun tryUnlock(password: String): Boolean {
        if (password.isBlank() || prefs.unlockHash.isBlank() || prefs.unlockSalt.isBlank()) return false
        val ok = try {
            val salt = hexToBytes(prefs.unlockSalt)
            val spec = javax.crypto.spec.PBEKeySpec(password.toCharArray(), salt, prefs.unlockIter, 256)
            val f = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            bytesToHex(f.generateSecret(spec).encoded) == prefs.unlockHash.lowercase()
        } catch (e: Exception) { Log.w(TAG, "Unlock-Prüfung", e); false }
        if (!ok) return false
        // Lokal sofort entsperren + kurzzeitig nicht wieder sperren, Zähler zurücksetzen
        prefs.noLockUntil = System.currentTimeMillis() + maxOf(prefs.fenceGraceS, 120) * 1000L
        prefs.outsideSince = 0L; prefs.outsideCount = 0
        prefs.pendingUnlock = true
        pendingUnlockPw = password
        applyLockState(false, "")
        // Server informieren (oder später beim nächsten flush)
        app.scope.launch { runCatching { pushUnlock(password) } }
        return true
    }

    private suspend fun pushUnlock(password: String) {
        try {
            val status = api().deviceUnlock(prefs.deviceId, password)
            prefs.pendingUnlock = false
            pendingUnlockPw = null
            prefs.theftLockSeq = status.lockSeq
            applyServerState(status)
        } catch (e: Exception) { Log.w(TAG, "Unlock an Server – später erneut", e) }
    }

    private fun hexToBytes(h: String): ByteArray =
        ByteArray(h.length / 2) { ((h[it * 2].digitToInt(16) shl 4) + h[it * 2 + 1].digitToInt(16)).toByte() }
    private fun bytesToHex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

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
        // Offline erfolgtes Entsperren jetzt (online) nachreichen
        if (prefs.pendingUnlock) pendingUnlockPw?.let { runCatching { pushUnlock(it) } }
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
                    appOutside = prefs.outsideSince > 0, appLocked = prefs.theftLocked,
                    wifiSsid = currentSsid()))
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
