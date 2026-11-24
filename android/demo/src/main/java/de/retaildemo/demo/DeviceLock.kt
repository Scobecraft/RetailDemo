package de.retaildemo.demo

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Sperrt das Gerät bei Diebstahl auf Android-/OS-Ebene.
 *
 * Wichtig (Android-Grenze): Ein normales App darf das System-Entsperrpasswort NICHT setzen. Das geht nur,
 * wenn das Gerät als „Geräteeigentümer" (Device Owner) eingerichtet ist – einmalig per ADB auf einem frisch
 * zurückgesetzten Gerät:  adb shell dpm set-device-owner de.retaildemo.demo/.TheftAdminReceiver
 * Dann setzt die App bei Diebstahl automatisch das auf der Webseite festgelegte Entsperrpasswort und
 * entfernt es beim Entsperren wieder. Ist das Gerät nur „Geräteadministrator" (ohne Owner), wird wenigstens der Bildschirm gesperrt
 * (lockNow); den stärksten Schutz bietet zusätzlich der Sperrbildschirm der App (Bedienungshilfe).
 */
object DeviceLock {
    private const val TAG = "DeviceLock"
    // fester Token, damit das Passwort auch ohne Nutzerbestätigung gesetzt/entfernt werden kann (nur Device Owner)
    private val TOKEN = ByteArray(32) { (it * 7 + 13).toByte() }

    private fun dpm(ctx: Context) = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private fun admin(ctx: Context) = TheftAdminReceiver.component(ctx)

    fun isAdminActive(ctx: Context) = runCatching { dpm(ctx).isAdminActive(admin(ctx)) }.getOrDefault(false)
    fun isDeviceOwner(ctx: Context) = runCatching { dpm(ctx).isDeviceOwnerApp(ctx.packageName) }.getOrDefault(false)

    /** Geräteadministrator aktivieren (System-Dialog). Für Device Owner nicht nötig. */
    fun requestAdmin(activity: Activity) {
        runCatching {
            activity.startActivity(Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin(activity))
                .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    "Für die OS-Sperre bei Diebstahl (Gerät sperren / Entsperrpasswort setzen)."))
        }
    }

    private fun ensureToken(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 26 || !isDeviceOwner(ctx)) return false
        return try {
            val d = dpm(ctx); val a = admin(ctx)
            if (!d.isResetPasswordTokenActive(a)) runCatching { d.setResetPasswordToken(a, TOKEN) }
            d.isResetPasswordTokenActive(a)
        } catch (e: Exception) { Log.w(TAG, "Token", e); false }
    }

    /** Bei Diebstahl: das übergebene Entsperrpasswort setzen (nur Device Owner) und Bildschirm sperren.
     *  Leere PIN = nur sperren, kein Passwort setzen. */
    fun enforce(ctx: Context, pin: String) {
        if (pin.length >= 4 && Build.VERSION.SDK_INT >= 26 && ensureToken(ctx)) {
            runCatching { dpm(ctx).resetPasswordWithToken(admin(ctx), pin, TOKEN, 0) }
                .onFailure { Log.w(TAG, "Passwort setzen", it) }
        }
        lockNow(ctx)
    }

    /** Beim Entsperren: das bei Diebstahl gesetzte Passwort wieder entfernen (nur Device Owner). */
    fun clear(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26 && ensureToken(ctx)) {
            runCatching { dpm(ctx).resetPasswordWithToken(admin(ctx), "", TOKEN, 0) }
        }
    }

    fun lockNow(ctx: Context) {
        if (isAdminActive(ctx)) runCatching { dpm(ctx).lockNow() }
    }
}
