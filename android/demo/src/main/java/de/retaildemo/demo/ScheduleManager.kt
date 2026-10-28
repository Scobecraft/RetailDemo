package de.retaildemo.demo

import android.accessibilityservice.AccessibilityService
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.util.Log
import de.retaildemo.core.Schedule
import de.retaildemo.core.isActiveAt
import de.retaildemo.core.nextChange
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Betriebszeiten: Außerhalb der eingestellten Zeiten ist die Demo aus und das Display geht in Standby.
 * Zur Einschaltzeit weckt ein Wecker (AlarmManager) das Gerät und startet die Demo.
 */
class ScheduleManager(private val app: DemoApp) {

    private val _active = MutableStateFlow(true)
    /** true = innerhalb der Betriebszeiten (Demo soll laufen). */
    val active: StateFlow<Boolean> = _active

    var nextChange: LocalDateTime? = null
        private set

    private val schedule: Schedule get() = app.sync.manifest.value?.schedule ?: Schedule()

    fun start(scope: CoroutineScope) {
        scope.launch {
            // Neuer Zeitplan vom Server -> sofort neu berechnen
            app.sync.manifest.collect { refresh(fromAlarm = false) }
        }
        scope.launch {
            // Sicherheitsnetz, falls ein Wecker verspätet kommt, während das Gerät wach ist
            while (true) {
                delay(30_000)
                refresh(fromAlarm = false)
            }
        }
    }

    /** Status neu berechnen, Demo starten bzw. Gerät schlafen legen, nächsten Wecker stellen. */
    fun refresh(fromAlarm: Boolean) {
        val now = LocalDateTime.now()
        val wasActive = _active.value
        val isActive = schedule.isActiveAt(now)
        _active.value = isActive
        nextChange = schedule.nextChange(now)
        scheduleAlarm(nextChange)

        if (isActive && (!wasActive || fromAlarm)) {
            Log.i(TAG, "Betriebszeit beginnt -> Demo starten")
            app.sync.playerStatus = "Demo läuft"
            if (app.prefs.isConfigured && !app.isUiVisible) wakeAndStartDemo(app)
        } else if (!isActive && (wasActive || fromAlarm)) {
            Log.i(TAG, "Betriebszeit endet -> Standby")
            app.sync.playerStatus = "Ruhezeit"
            goToSleep()
        }
    }

    /** Display ausschalten (Android 9+, über die Bedienungshilfe). */
    fun goToSleep() {
        app.closeDemo()
        if (Build.VERSION.SDK_INT >= 28) {
            IdleWatcherService.instance?.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
        }
    }

    private fun scheduleAlarm(at: LocalDateTime?) {
        val am = app.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(
            app, 0, Intent(app, ScheduleReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        am.cancel(pi)
        if (at == null) return
        val millis = at.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, millis, pi)
        } else {
            // Ohne Erlaubnis für genaue Wecker: kann sich um einige Minuten verspäten
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, millis, pi)
        }
    }

    companion object {
        private const val TAG = "DemoSchedule"

        /** Weckt das Display und startet die Demo im Vordergrund. */
        @Suppress("DEPRECATION")
        fun wakeAndStartDemo(context: Context) {
            val pm = context.getSystemService(PowerManager::class.java)
            pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "RetailDemo:wake",
            ).acquire(5_000)
            try {
                context.startActivity(
                    Intent(context, DemoActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                )
            } catch (e: Exception) {
                Log.w(TAG, "Demo konnte nicht gestartet werden", e)
            }
        }
    }
}

/** Wird vom Wecker zur An-/Ausschaltzeit aufgerufen. */
class ScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        context.demoApp.schedule.refresh(fromAlarm = true)
    }
}
