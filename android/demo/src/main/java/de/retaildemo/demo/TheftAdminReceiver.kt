package de.retaildemo.demo

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context

/** Geräteverwaltungs-Empfänger – nötig, um bei Diebstahl das Gerät auf OS-Ebene zu sperren. */
class TheftAdminReceiver : DeviceAdminReceiver() {
    companion object {
        fun component(ctx: Context) = ComponentName(ctx, TheftAdminReceiver::class.java)
    }
}
