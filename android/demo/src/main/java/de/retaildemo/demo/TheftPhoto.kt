package de.retaildemo.demo

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import android.util.Log

/**
 * Macht bei (vermutetem) Diebstahl heimlich ein Frontkamera-Foto – als Beweis/Abschreckung.
 * Ohne Vorschau, ohne Google-Dienste (CameraX/Camera2). Bricht leise ab, wenn keine Kamera/Berechtigung.
 */
object TheftPhoto {
    private const val TAG = "TheftPhoto"

    fun hasPermission(activity: ComponentActivity) =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    fun capture(activity: ComponentActivity, onJpeg: (ByteArray?) -> Unit) {
        if (!hasPermission(activity)) { onJpeg(null); return }
        val exec = ContextCompat.getMainExecutor(activity)
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener({
            var provider: ProcessCameraProvider? = null
            try {
                provider = future.get()
                val cap = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
                val selector = if (provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA))
                    CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                provider.unbindAll()
                provider.bindToLifecycle(activity, selector, cap)
                val p = provider
                cap.takePicture(exec, object : ImageCapture.OnImageCapturedCallback() {
                    override fun onCaptureSuccess(image: ImageProxy) {
                        val jpeg = try {
                            val buf = image.planes[0].buffer
                            ByteArray(buf.remaining()).also { buf.get(it) }
                        } catch (e: Exception) { null } finally { image.close() }
                        runCatching { p.unbindAll() }
                        onJpeg(jpeg)
                    }
                    override fun onError(exc: ImageCaptureException) {
                        Log.w(TAG, "Foto fehlgeschlagen", exc)
                        runCatching { p.unbindAll() }
                        onJpeg(null)
                    }
                })
            } catch (e: Exception) {
                Log.w(TAG, "Kamera nicht verfügbar", e)
                runCatching { provider?.unbindAll() }
                onJpeg(null)
            }
        }, exec)
    }
}
