package de.retaildemo.demo

import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Sperrbildschirm bei (vermutetem) Diebstahl: nicht wegklickbar, mit nicht abschaltbarem Alarmton und
 * einem seriösen zweisprachigen Warnhinweis (Deutsch/Englisch). Entsperrt wird nur über den Server –
 * der [TheftGuard] setzt dann den `locked`-Flow auf false und dieser Bildschirm schließt sich.
 */
class TheftLockActivity : ComponentActivity() {
    private var player: MediaPlayer? = null
    private var audio: AudioManager? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Über dem Sperrbildschirm zeigen, Display an, nie ausschalten
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true); setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { /* zurück-Taste gesperrt */ }
        })

        val store = demoApp.prefs.manifest?.storeName?.takeIf { it.isNotBlank() }
        val logo = demoApp.druck.logo
        setContent {
            val locked by demoApp.theft.locked.collectAsState()
            LaunchedEffect(locked) { if (!locked) { stopAlarm(); finish() } }
            LockScreen(store = store, isTest = demoApp.theft.isTest,
                protectionId = java.util.UUID.nameUUIDFromBytes(demoApp.prefs.deviceId.toByteArray()).toString().take(8).uppercase(),
                logo = logo?.let { runCatching { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() },
                hasPassword = demoApp.prefs.unlockHash.isNotBlank(),
                onUnlock = { pw -> demoApp.theft.tryUnlock(pw) })
        }
        startAlarm()
    }

    override fun onResume() {
        super.onResume()
        if (!demoApp.theft.locked.value) finish() else startAlarm()
    }

    // Verlässt der Dieb den Bildschirm (Home-Taste), sofort wieder nach vorne holen.
    override fun onUserLeaveHint() {
        if (demoApp.theft.locked.value) {
            startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        }
        super.onUserLeaveHint()
    }

    override fun onPause() {
        super.onPause()
        if (demoApp.theft.locked.value) TheftService.ensureRunning(this)
    }

    // Lautstärke-Tasten dürfen den Alarm nicht leiser/aus machen – Down wie Up abfangen,
    // damit weder Lautstärke sinkt noch der System-Lautstärkeregler erscheint.
    private fun isVolKey(keyCode: Int) =
        keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP ||
        keyCode == KeyEvent.KEYCODE_VOLUME_MUTE

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (isVolKey(keyCode)) { maxVolume(); return true }
        return super.onKeyDown(keyCode, event)
    }
    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (isVolKey(keyCode)) { maxVolume(); return true }
        return super.onKeyUp(keyCode, event)
    }
    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (isVolKey(keyCode)) { maxVolume(); return true }
        return super.onKeyLongPress(keyCode, event)
    }

    // Erkennt jede Lautstärke-Änderung sofort (z. B. über Schnelleinstellungen/Bluetooth) und dreht wieder auf.
    private var volObserver: android.database.ContentObserver? = null

    private fun maxVolume() {
        val am = audio ?: return
        try {
            // Nicht-Stören / Stumm umgehen, Alarm ist von DND ausgenommen
            if (am.ringerMode != AudioManager.RINGER_MODE_NORMAL) {
                runCatching { am.ringerMode = AudioManager.RINGER_MODE_NORMAL }
            }
            val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            if (am.getStreamVolume(AudioManager.STREAM_ALARM) != max) {
                am.setStreamVolume(AudioManager.STREAM_ALARM, max, 0)
            }
        } catch (_: Exception) {}
    }

    private fun startAlarm() {
        if (player?.isPlaying == true) return
        audio = getSystemService(AUDIO_SERVICE) as AudioManager
        maxVolume()
        registerVolumeGuard()
        try {
            player = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                val afd = resources.openRawResourceFd(R.raw.theft_alarm)
                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length); afd.close()
                isLooping = true
                setVolume(1f, 1f)
                prepare(); start()
            }
        } catch (e: Exception) { android.util.Log.w("TheftLock", "Alarm", e) }
        // Zusätzliche Absicherung: Lautstärke engmaschig oben halten, Wiedergabe neu starten falls gestoppt
        lifecycleScope.launch {
            while (demoApp.theft.locked.value) {
                maxVolume()
                player?.setVolume(1f, 1f)
                if (player?.isPlaying == false) runCatching { player?.start() }
                delay(300)
            }
        }
    }

    private fun registerVolumeGuard() {
        if (volObserver != null) return
        val obs = object : android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { maxVolume() }
        }
        runCatching {
            contentResolver.registerContentObserver(
                android.provider.Settings.System.CONTENT_URI, true, obs)
        }
        volObserver = obs
    }

    private fun stopAlarm() {
        volObserver?.let { runCatching { contentResolver.unregisterContentObserver(it) } }
        volObserver = null
        runCatching { player?.stop(); player?.release() }
        player = null
    }

    override fun onDestroy() { stopAlarm(); super.onDestroy() }
}

private val ORANGE = Color(0xFFEE7F00)

@androidx.compose.runtime.Composable
private fun LockScreen(store: String?, isTest: Boolean, protectionId: String, logo: android.graphics.Bitmap?,
                       hasPassword: Boolean, onUnlock: (String) -> Boolean) {
    val now = remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        while (true) {
            now.value = java.text.SimpleDateFormat("EEEE, dd.MM.yyyy · HH:mm:ss", java.util.Locale.GERMANY)
                .format(java.util.Date())
            delay(1000)
        }
    }
    Column(
        Modifier.fillMaxSize().background(Color(0xFF0A0A0C)).verticalScroll(rememberScrollState())
            .padding(horizontal = 26.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (isTest) {
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0xFF1D4ED8)).padding(8.dp),
                contentAlignment = Alignment.Center) {
                Text("● TEST – vom Händler ausgelöst / triggered by retailer", color = Color.White,
                    fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(18.dp))
        }
        // Schloss-Symbol im Android-Stil
        Box(Modifier.size(96.dp).clip(RoundedCornerShape(48.dp)).background(Color(0x22EE7F00)),
            contentAlignment = Alignment.Center) {
            Text("🔒", fontSize = 48.sp)
        }
        Spacer(Modifier.height(18.dp))
        Text("GERÄT GESPERRT", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Black)
        Text("DEVICE LOCKED", color = ORANGE, fontSize = 17.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("Diebstahlschutz aktiviert · Anti-Theft Protection Active",
            color = Color(0xFFB8BCC6), fontSize = 13.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(22.dp))

        Section(flag = "DE", title = "Dieses Gerät wird durch ein Sicherheitssystem geschützt", lines = listOf(
            "Dieses Smartphone ist Eigentum von ${store ?: "einem Fachhändler"} und wurde als verloren oder entwendet gemeldet.",
            "• Der Standort wird fortlaufend erfasst und protokolliert (GPS-Überwachung).",
            "• Die Standortdaten werden im Diebstahlfall den Strafverfolgungsbehörden übergeben.",
            "• Manipulations- und Ausschaltversuche werden aufgezeichnet.",
            "• Das Gerät lässt sich ausschließlich durch den rechtmäßigen Eigentümer entsperren.",
            "Bringen Sie dieses Gerät umgehend zurück.",
        ))
        Spacer(Modifier.height(18.dp))
        Section(flag = "EN", title = "This device is protected by a security system", lines = listOf(
            "This smartphone is the property of ${store ?: "an authorised retailer"} and has been reported lost or stolen.",
            "• Its location is continuously recorded and logged (GPS monitoring).",
            "• In case of theft, location data is handed over to law enforcement.",
            "• Tampering and shutdown attempts are recorded.",
            "• The device can only be unlocked by its rightful owner.",
            "Return this device immediately.",
        ))

        Spacer(Modifier.height(22.dp))
        logo?.let {
            Image(it.asImageBitmap(), null, Modifier.height(30.dp))
            Spacer(Modifier.height(8.dp))
        }
        Text(now.value, color = Color(0xFF6B7280), fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        Text("Geräte-Schutz-ID: $protectionId", color = Color(0xFF4B5563), fontSize = 11.sp, fontFamily = FontFamily.Monospace)

        if (hasPassword) {
            Spacer(Modifier.height(20.dp))
            var open by remember { mutableStateOf(false) }
            var pw by remember { mutableStateOf("") }
            var err by remember { mutableStateOf(false) }
            if (!open) {
                TextButton(onClick = { open = true }) {
                    Text("Admin-Entsperrung", color = Color(0xFF9AA0AA), fontSize = 13.sp)
                }
            } else {
                OutlinedTextField(
                    value = pw, onValueChange = { pw = it; err = false },
                    label = { Text("Admin-Passwort") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    isError = err,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color(0xFF15171C), unfocusedContainerColor = Color(0xFF15171C),
                        focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                        focusedLabelColor = ORANGE, unfocusedLabelColor = Color(0xFF9AA0AA),
                        focusedIndicatorColor = ORANGE, unfocusedIndicatorColor = Color(0xFF3A3D44)),
                    modifier = Modifier.fillMaxWidth())
                if (err) Text("Falsches Passwort", color = Color(0xFFE5484D), fontSize = 12.sp,
                    modifier = Modifier.padding(top = 4.dp))
                Spacer(Modifier.height(8.dp))
                Row {
                    Button(onClick = { if (!onUnlock(pw)) err = true },
                        colors = ButtonDefaults.buttonColors(containerColor = ORANGE)) { Text("Entsperren") }
                    Spacer(Modifier.width(10.dp))
                    TextButton(onClick = { open = false; pw = ""; err = false }) {
                        Text("Abbrechen", color = Color(0xFF9AA0AA))
                    }
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun Section(flag: String, title: String, lines: List<String>) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Color(0xFF15171C))
        .padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.clip(RoundedCornerShape(5.dp)).background(ORANGE).padding(horizontal = 7.dp, vertical = 2.dp)) {
                Text(flag, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Black)
            }
            Spacer(Modifier.width(8.dp))
            Text(title, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(10.dp))
        lines.forEach {
            Text(it, color = Color(0xFFD4D7DE), fontSize = 13.sp, lineHeight = 19.sp,
                modifier = Modifier.padding(bottom = 6.dp))
        }
    }
}

