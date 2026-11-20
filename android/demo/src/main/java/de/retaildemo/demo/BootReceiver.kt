package de.retaildemo.demo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.launch

/** Startet die Demo nach einem Neustart des Geräts (und nach einem App-Update). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.demoApp // startet auch den Abgleich mit dem Server (und theft.init -> Sperre bei Diebstahl)
        // Diebstahlschutz: Standortdienst sofort starten (auch außerhalb der Betriebszeiten / pausiert),
        // damit ein geklautes Gerät beim Einschalten gleich den Standort meldet.
        if (app.prefs.isConfigured) {
            TheftService.ensureRunning(context)
            app.scope.launch { runCatching { app.theft.flush(force = true) } }
        }
        if (!app.prefs.isConfigured || !app.schedule.active.value || app.prefs.isPaused) return
        // Funktioniert, wenn "Über anderen Apps einblenden" erlaubt ist. Sonst übernimmt der
        // Bedienungshilfe-Dienst nach Ablauf der Wartezeit.
        try {
            context.startActivity(
                Intent(context, DemoActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            Log.w("DemoBoot", "Autostart nicht möglich", e)
        }
    }
}
