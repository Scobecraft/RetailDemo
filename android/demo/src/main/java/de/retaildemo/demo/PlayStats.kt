package de.retaildemo.demo

import android.content.Context
import android.util.Log
import de.retaildemo.core.ApiClient
import de.retaildemo.core.StatEvent
import de.retaildemo.core.StatReport
import java.io.File

/**
 * Sammelt Wiedergaben (welches Video/Bild wie lange) und Kundenkontakte (Demo durch Antippen beendet)
 * und meldet sie gesammelt an den Server (Seite "Statistik"). Ohne Netz bleiben sie in einer Datei
 * liegen und gehen beim nächsten Mal mit.
 */
class PlayStats(context: Context) {
    private val file = File(context.filesDir, "stats-queue.jsonl")
    private val lock = Any()
    private var current: Triple<String, String?, Long>? = null // type, mediaId, Startzeit (ms)
    private var interrupted = false

    /** Neue Folie beginnt (beendet die vorige). */
    fun begin(type: String, mediaId: String?) {
        end(completed = true)
        synchronized(lock) { current = Triple(type, mediaId, System.currentTimeMillis()); interrupted = false }
    }

    /** Aktuelle Folie zu Ende (abgelaufen oder vom Kunden unterbrochen). */
    fun end(completed: Boolean = !interrupted) {
        val c = synchronized(lock) { current.also { current = null } } ?: return
        val dur = (System.currentTimeMillis() - c.third) / 1000.0
        if (dur < 0.5) return
        add(StatEvent(type = c.first, mediaId = c.second, start = c.third / 1000.0, durationS = dur, completed = completed && !interrupted))
    }

    /** Kunde hat die Demo durch Antippen beendet. */
    fun touch() {
        synchronized(lock) { interrupted = true }
        end(completed = false)
        add(StatEvent(type = "touch", start = System.currentTimeMillis() / 1000.0))
    }

    private fun add(e: StatEvent) = synchronized(lock) {
        runCatching {
            if (file.length() > 2_000_000) file.delete() // Notbremse: nie unbegrenzt wachsen
            file.appendText(ApiClient.JSON.encodeToString(StatEvent.serializer(), e) + "\n")
        }
    }

    /** Gesammeltes an den Server schicken (vom Herzschlag aus aufgerufen). */
    suspend fun flush(api: ApiClient, deviceId: String) {
        val lines = synchronized(lock) {
            if (!file.exists()) return
            val l = runCatching { file.readLines() }.getOrDefault(emptyList())
            file.delete()
            l
        }
        val events = lines.mapNotNull { runCatching { ApiClient.JSON.decodeFromString(StatEvent.serializer(), it) }.getOrNull() }
        if (events.isEmpty()) return
        try {
            events.chunked(1000).forEach { api.postStats(StatReport(deviceId, it)) }
        } catch (e: Exception) {
            Log.w("PlayStats", "Statistik nicht gesendet – später nochmal", e)
            synchronized(lock) { runCatching { file.appendText(lines.joinToString("\n", postfix = "\n")) } }
        }
    }
}
