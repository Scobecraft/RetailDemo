package de.retaildemo.demo

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.Settings
import android.view.WindowManager
import de.retaildemo.core.Spec
import java.io.File
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** Liest automatisch die technischen Daten des Geräts aus. */
object DeviceInfo {

    fun manufacturer(): String = Build.MANUFACTURER.replaceFirstChar { it.titlecase(Locale.GERMAN) }

    /** Verkaufsname, z. B. "Galaxy S24 Ultra" statt "SM-S928B" (falls das Gerät ihn kennt). */
    fun marketingName(context: Context): String {
        val candidates = listOfNotNull(
            runCatching { Settings.Global.getString(context.contentResolver, "device_name") }.getOrNull(),
            runCatching { systemProperty("ro.product.marketname") }.getOrNull(),
            runCatching { systemProperty("ro.config.marketing_name") }.getOrNull(),
        )
        return candidates.firstOrNull { it.isNotBlank() } ?: Build.MODEL
    }

    fun androidVersion() = "Android ${Build.VERSION.RELEASE}"

    fun specs(context: Context): List<Spec> = buildList {
        runCatching { display(context) }.getOrNull()?.let { add(Spec("Display", it)) }
        runCatching { processor() }.getOrNull()?.let { add(Spec("Prozessor", it)) }
        runCatching { ram(context) }.getOrNull()?.let { add(Spec("Arbeitsspeicher", it)) }
        runCatching { storage() }.getOrNull()?.let { add(Spec("Speicher", it)) }
        runCatching { cameras(context, CameraCharacteristics.LENS_FACING_BACK) }.getOrNull()
            ?.let { add(Spec("Hauptkamera", it)) }
        runCatching { cameras(context, CameraCharacteristics.LENS_FACING_FRONT) }.getOrNull()
            ?.let { add(Spec("Frontkamera", it)) }
        runCatching { battery(context) }.getOrNull()?.let { add(Spec("Akku", it)) }
        add(Spec("Betriebssystem", androidVersion()))
    }

    fun batteryPercent(context: Context): Int? {
        val i = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        return if (level >= 0 && scale > 0) level * 100 / scale else null
    }

    // ------------------------------------------------------------------------

    @Suppress("DEPRECATION")
    private fun display(context: Context): String? {
        val wm = context.getSystemService(WindowManager::class.java)
        val display = wm.defaultDisplay
        val (bw, bh) = if (Build.VERSION.SDK_INT >= 30) {
            wm.maximumWindowMetrics.bounds.let { it.width() to it.height() }
        } else {
            android.util.DisplayMetrics().also { display.getRealMetrics(it) }.let { it.widthPixels to it.heightPixels }
        }
        val w = minOf(bw, bh)
        val h = maxOf(bw, bh)
        val dm = context.resources.displayMetrics
        val inches = sqrt((w / dm.xdpi).let { it * it } + (h / dm.ydpi).let { it * it })
        val hz = display.supportedModes.maxOfOrNull { it.refreshRate }?.roundToInt()
        return buildString {
            append(String.format(Locale.GERMAN, "%.1f\"", inches))
            append(" · $w × $h")
            if (hz != null && hz > 60) append(" · $hz Hz")
        }
    }

    private fun processor(): String? {
        val soc = if (Build.VERSION.SDK_INT >= 31) {
            listOf(Build.SOC_MANUFACTURER, Build.SOC_MODEL)
                .filter { it.isNotBlank() && it != Build.UNKNOWN }.joinToString(" ")
        } else ""
        val cores = Runtime.getRuntime().availableProcessors()
        val maxGhz = (0 until cores).mapNotNull {
            runCatching { File("/sys/devices/system/cpu/cpu$it/cpufreq/cpuinfo_max_freq").readText().trim().toLong() }
                .getOrNull()
        }.maxOrNull()?.let { it / 1_000_000.0 }
        val parts = mutableListOf<String>()
        if (soc.isNotBlank()) parts += soc else if (Build.HARDWARE.isNotBlank()) parts += Build.HARDWARE
        parts += "$cores Kerne"
        if (maxGhz != null && maxGhz > 0.3) parts += String.format(Locale.GERMAN, "bis %.1f GHz", maxGhz)
        return parts.joinToString(" · ")
    }

    private fun ram(context: Context): String {
        val mi = ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java).getMemoryInfo(mi)
        val gb = mi.totalMem / 1_000_000_000.0
        // Betriebssystem reserviert etwas -> auf übliche Größen aufrunden
        val size = listOf(1, 2, 3, 4, 6, 8, 10, 12, 16, 18, 24, 32).firstOrNull { it >= gb * 0.9 } ?: gb.roundToInt()
        return "$size GB"
    }

    private fun storage(): String {
        val total = StatFs(Environment.getDataDirectory().path).totalBytes / 1_000_000_000.0
        val size = listOf(8, 16, 32, 64, 128, 256, 512, 1024, 2048).firstOrNull { it >= total } ?: total.roundToInt()
        return if (size >= 1024) "${size / 1024} TB" else "$size GB"
    }

    private fun cameras(context: Context, facing: Int): String? {
        val cm = context.getSystemService(CameraManager::class.java)
        val mps = cm.cameraIdList.mapNotNull { id ->
            val c = cm.getCameraCharacteristics(id)
            if (c.get(CameraCharacteristics.LENS_FACING) != facing) return@mapNotNull null
            val size = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE) ?: return@mapNotNull null
            (size.width.toLong() * size.height / 1_000_000.0).roundToInt()
        }.filter { it > 0 }.sortedDescending()
        if (mps.isEmpty()) return null
        return mps.joinToString(" + ") { "$it MP" }
    }

    @SuppressLint("PrivateApi")
    private fun battery(context: Context): String? {
        // 1. Versuch: interne PowerProfile-Klasse (liefert die Nennkapazität)
        val mah = runCatching {
            val cls = Class.forName("com.android.internal.os.PowerProfile")
            val profile = cls.getConstructor(Context::class.java).newInstance(context)
            (cls.getMethod("getBatteryCapacity").invoke(profile) as Double)
        }.getOrNull()?.takeIf { it > 500 }
            // 2. Versuch: aktuelle Ladung hochrechnen
            ?: runCatching {
                val bm = context.getSystemService(BatteryManager::class.java)
                val counter = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER) // µAh
                val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                if (counter > 0 && pct > 10) counter / 1000.0 / pct * 100 else null
            }.getOrNull()
        return mah?.let { "${(it / 50).roundToInt() * 50} mAh" }
    }

    @SuppressLint("PrivateApi")
    private fun systemProperty(key: String): String? {
        val cls = Class.forName("android.os.SystemProperties")
        return (cls.getMethod("get", String::class.java).invoke(null, key) as String).ifBlank { null }
    }
}
