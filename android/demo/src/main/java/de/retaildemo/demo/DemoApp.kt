package de.retaildemo.demo

import android.app.Activity
import android.app.Application
import android.os.Bundle
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.concurrent.TimeUnit

class DemoApp : Application() {

    lateinit var prefs: Prefs
        private set
    lateinit var sync: SyncManager
        private set
    lateinit var schedule: ScheduleManager
        private set
    lateinit var cleanup: CleanupManager
        private set

    /** true, solange die Demo-Wiedergabe im Vordergrund läuft. */
    @Volatile var demoVisible = false

    /** Bis zu diesem Zeitpunkt (elapsedRealtime) ist Deinstallieren nach PIN-Eingabe erlaubt. */
    @Volatile var uninstallUnlockedUntil = 0L

    /** Wird von der laufenden Demo gesetzt, damit sie von außen beendet werden kann. */
    @Volatile var closeDemoCallback: (() -> Unit)? = null
    fun closeDemo() { closeDemoCallback?.invoke() }

    /** Demo pausieren: Gerät ist frei benutzbar, Sperren und Aufräumen sind aus. [minutes] = null -> bis "Fortsetzen". */
    fun pauseDemo(minutes: Int?) {
        val until = if (minutes == null) Long.MAX_VALUE else System.currentTimeMillis() + minutes * 60_000L
        prefs.pausedUntil = until
        sync.playerStatus = pauseLabel()
        closeDemo()
    }

    fun resumeDemo() {
        prefs.pausedUntil = 0
        sync.playerStatus = "Demo läuft"
    }

    fun pauseLabel(): String {
        val until = prefs.pausedUntil
        if (until == Long.MAX_VALUE) return "Pausiert"
        val t = java.time.Instant.ofEpochMilli(until).atZone(java.time.ZoneId.systemDefault()).toLocalTime()
        return "Pausiert bis %02d:%02d".format(t.hour, t.minute)
    }

    /** Läuft so lange wie der Prozess; der Bedienungshilfe-Dienst hält den Prozess am Leben. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private var resumedActivities = 0

    /** true, solange irgendein Bildschirm dieser App im Vordergrund ist. */
    val isUiVisible get() = resumedActivities > 0

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        sync = SyncManager(this)
        sync.start(scope)
        schedule = ScheduleManager(this)
        schedule.start(scope)
        cleanup = CleanupManager(this)
        cleanup.start(scope)

        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityResumed(a: Activity) { resumedActivities++ }
            override fun onActivityPaused(a: Activity) { resumedActivities-- }
            override fun onActivityCreated(a: Activity, b: Bundle?) {}
            override fun onActivityStarted(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        })

        // Sicherheitsnetz, falls Android den Prozess beendet: WorkManager weckt die App regelmäßig.
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "sync",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(60, TimeUnit.MINUTES).build(),
        )
    }
}

val android.content.Context.demoApp get() = applicationContext as DemoApp
