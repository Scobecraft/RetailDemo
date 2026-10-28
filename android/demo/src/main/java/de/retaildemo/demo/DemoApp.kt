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
