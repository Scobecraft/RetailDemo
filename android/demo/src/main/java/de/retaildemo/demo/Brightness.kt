package de.retaildemo.demo

import android.content.Context
import android.provider.Settings
import android.util.Log

/** Stellt die System-Helligkeit auf 100 % (braucht die Erlaubnis "Systemeinstellungen ändern"). */
object Brightness {
    fun canWrite(context: Context) = Settings.System.canWrite(context)

    fun setMax(context: Context) {
        if (!context.demoApp.prefs.maxBrightness || !canWrite(context)) return
        runCatching {
            val cr = context.contentResolver
            Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
            Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS, 255)
        }.onFailure { Log.w("DemoBrightness", "Helligkeit konnte nicht gesetzt werden", it) }
    }
}
