package de.retaildemo.demo

import android.Manifest
import android.app.WallpaperManager
import android.content.ContentUris
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Räumt regelmäßig hinter den Kunden auf:
 * - löscht Fotos, Videos und Screenshots (Ordner DCIM, Pictures, Movies)
 * - setzt das Hintergrundbild (Start- und Sperrbildschirm) auf den Standard zurück
 *
 * Läuft nur, wenn gerade die Demo spielt oder Ruhezeit ist – nie, während ein Kunde das Gerät benutzt.
 */
class CleanupManager(private val app: DemoApp) {

    private val mutex = Mutex()
    private val _state = MutableStateFlow("")
    val state: StateFlow<String> = _state

    private val intervalH get() = app.sync.manifest.value?.cleanupIntervalH ?: 2

    fun start(scope: CoroutineScope) {
        scope.launch {
            while (true) {
                delay(60_000)
                val due = intervalH > 0 &&
                    System.currentTimeMillis() - app.prefs.lastCleanup >= intervalH * 3_600_000L
                val customerAway = app.demoVisible || !app.schedule.active.value
                if (due && customerAway && app.prefs.isConfigured) runNow()
            }
        }
    }

    fun hasStorageAccess(): Boolean = if (Build.VERSION.SDK_INT >= 30) {
        Environment.isExternalStorageManager()
    } else {
        app.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    /** Aufräumen sofort ausführen. Gibt eine kurze Zusammenfassung zurück. */
    suspend fun runNow(): String = mutex.withLock {
        withContext(Dispatchers.IO) {
            val deleted = if (hasStorageAccess()) deleteGuestMedia() else -1
            val wallpaperOk = resetWallpaper()
            app.prefs.lastCleanup = System.currentTimeMillis()
            val summary = buildString {
                append(if (deleted >= 0) "$deleted Datei(en) gelöscht" else "Fotos: keine Berechtigung")
                append(if (wallpaperOk) ", Hintergrund zurückgesetzt" else ", Hintergrund: Fehler")
            }
            Log.i(TAG, summary)
            _state.value = summary
            summary
        }
    }

    private fun deleteGuestMedia(): Int {
        var count = 0
        val root = Environment.getExternalStorageDirectory()
        val folders = listOf(Environment.DIRECTORY_DCIM, Environment.DIRECTORY_PICTURES, Environment.DIRECTORY_MOVIES)

        // 1. Über die Medien-Datenbank löschen (damit die Galerie sofort leer ist)
        val cr = app.contentResolver
        val collection = MediaStore.Files.getContentUri("external")
        val (selection, args) = if (Build.VERSION.SDK_INT >= 29) {
            folders.joinToString(" OR ") { "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?" } to
                folders.map { "$it/%" }.toTypedArray()
        } else {
            @Suppress("DEPRECATION")
            folders.joinToString(" OR ") { "${MediaStore.MediaColumns.DATA} LIKE ?" } to
                folders.map { "${File(root, it).absolutePath}/%" }.toTypedArray()
        }
        runCatching {
            cr.query(collection, arrayOf(MediaStore.MediaColumns._ID), selection, args, null)?.use { c ->
                while (c.moveToNext()) {
                    val uri = ContentUris.withAppendedId(collection, c.getLong(0))
                    if (runCatching { cr.delete(uri, null, null) }.getOrDefault(0) > 0) count++
                }
            }
        }.onFailure { Log.w(TAG, "MediaStore-Löschen fehlgeschlagen", it) }

        // 2. Übrig gebliebene Dateien direkt löschen (Ordnerstruktur bleibt erhalten)
        folders.map { File(root, it) }.forEach { dir ->
            dir.walkBottomUp().filter { it.isFile }.forEach { if (it.delete()) count++ }
        }
        return count
    }

    private fun resetWallpaper(): Boolean = runCatching {
        val wm = WallpaperManager.getInstance(app)
        wm.clear(WallpaperManager.FLAG_SYSTEM or WallpaperManager.FLAG_LOCK)
        true
    }.onFailure { Log.w(TAG, "Hintergrund zurücksetzen fehlgeschlagen", it) }.getOrDefault(false)

    companion object { private const val TAG = "DemoCleanup" }
}
