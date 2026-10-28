package de.retaildemo.demo

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent

/**
 * Bedienungshilfe-Dienst: bemerkt Berührungen/Bedienung in anderen Apps.
 * Wurde das Gerät [Manifest.idleTimeoutS] Sekunden nicht benutzt, startet die Demo wieder.
 * (Wie bei den Apple/Samsung-Demogeräten im Laden.)
 */
class IdleWatcherService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())
    private var lastInteraction = SystemClock.elapsedRealtime()

    private val check = object : Runnable {
        override fun run() {
            checkIdle()
            handler.postDelayed(this, 5_000)
        }
    }

    override fun onServiceConnected() {
        lastInteraction = SystemClock.elapsedRealtime()
        handler.post(check)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.packageName?.toString() != packageName) {
            lastInteraction = SystemClock.elapsedRealtime()
        }
    }

    private fun checkIdle() {
        val app = demoApp
        if (app.isUiVisible || !app.prefs.isConfigured) {
            lastInteraction = SystemClock.elapsedRealtime()
            return
        }
        val timeoutMs = (app.sync.manifest.value?.idleTimeoutS ?: 60) * 1000L
        if (SystemClock.elapsedRealtime() - lastInteraction >= timeoutMs) {
            lastInteraction = SystemClock.elapsedRealtime()
            startActivity(
                Intent(this, DemoActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        handler.removeCallbacks(check)
        super.onDestroy()
    }
}
