package de.retaildemo.demo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Startet die Demo nach einem Neustart des Geräts (und nach einem App-Update). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.demoApp // startet auch den Abgleich mit dem Server
        if (!app.prefs.isConfigured) return
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
