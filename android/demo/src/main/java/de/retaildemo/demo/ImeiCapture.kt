package de.retaildemo.demo

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Liest IMEI und Seriennummer über den Code *#06# aus – als Rückfalllösung, falls Android sie der App
 * nicht direkt herausgibt (ab Android 10). Dafür wird der Telefon-Code *#06# gewählt; den dadurch
 * angezeigten System-Dialog liest die Bedienungshilfe (IdleWatcherService) aus. Funktioniert nur, wenn
 * die Bedienungshilfe eingeschaltet ist. Läuft nur bewusst (bei der Einrichtung), nicht während der Demo.
 */
object ImeiCapture {
    private const val TAG = "ImeiCapture"
    @Volatile var capturing = false
        private set
    private var startedAt = 0L
    private var onDone: ((imei: String?, serial: String?) -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())

    private val imeiRe = Regex("\\b\\d{15,16}\\b")

    fun start(context: Context, onDone: (imei: String?, serial: String?) -> Unit) {
        if (capturing) return
        this.onDone = onDone
        capturing = true
        startedAt = System.currentTimeMillis()
        try {
            // *#06# per Telefon-Code; auf den meisten Geräten erscheint sofort der IMEI/SN-Dialog
            val uri = Uri.fromParts("tel", "*#06#", null)
            context.startActivity(Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: SecurityException) {
            // ohne CALL_PHONE: Wählfeld mit vorausgefülltem Code öffnen (Nutzer bzw. System führt ihn aus)
            try {
                context.startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", "*#06#", null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e2: Exception) { finish(null, null); return }
        } catch (e: Exception) { finish(null, null); return }
        // Abbruch nach 12 s, falls kein lesbarer Dialog kam
        main.postDelayed({ if (capturing) finish(null, null) }, 12_000)
    }

    /** Von der Bedienungshilfe bei Fensteränderungen aufgerufen: Dialog nach IMEI/SN durchsuchen. */
    fun scan(root: AccessibilityNodeInfo?) {
        if (!capturing || root == null) return
        val texts = mutableListOf<String>()
        collect(root, texts)
        val joined = texts.joinToString(" | ")
        val numbers = imeiRe.findAll(joined).map { it.value }.toList()
        val imeis = numbers.filter { it.length == 15 && luhn(it) }.distinct()
        if (imeis.isEmpty()) return  // noch nicht der richtige Dialog
        // Seriennummer: eine Zeile, die "Seriennummer"/"Serial" enthält, oder ein alphanumerischer Code
        val serial = findSerial(texts)
        finish(imeis.joinToString("/"), serial)
        main.post { IdleWatcherService.instance?.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK) }
    }

    private fun finish(imei: String?, serial: String?) {
        if (!capturing) return
        capturing = false
        val cb = onDone; onDone = null
        Log.i(TAG, "Auslesen fertig: imei=${imei != null} serial=${serial != null}")
        main.post { cb?.invoke(imei, serial) }
    }

    private fun collect(n: AccessibilityNodeInfo?, out: MutableList<String>) {
        n ?: return
        (n.text ?: n.contentDescription)?.toString()?.trim()?.let { if (it.isNotEmpty()) out.add(it) }
        for (i in 0 until n.childCount) collect(n.getChild(i), out)
    }

    private fun findSerial(texts: List<String>): String? {
        texts.forEachIndexed { i, t ->
            val low = t.lowercase()
            if (low.contains("serien") || low.contains("serial")) {
                // Wert steht oft in derselben oder der nächsten Zeile
                Regex("[:\\s]([A-Z0-9]{6,20})\\b").find(t)?.groupValues?.getOrNull(1)?.let { return it }
                texts.getOrNull(i + 1)?.trim()?.takeIf { it.matches(Regex("[A-Z0-9]{6,20}")) }?.let { return it }
            }
        }
        return null
    }

    // IMEI hat eine gültige Luhn-Prüfziffer – so filtern wir zufällige 15-stellige Zahlen heraus
    private fun luhn(s: String): Boolean {
        var sum = 0; var alt = false
        for (i in s.length - 1 downTo 0) {
            var d = s[i] - '0'
            if (alt) { d *= 2; if (d > 9) d -= 9 }
            sum += d; alt = !alt
        }
        return sum % 10 == 0
    }
}
