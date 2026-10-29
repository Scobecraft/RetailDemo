package de.retaildemo.demo

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import de.retaildemo.core.Manifest
import de.retaildemo.core.ManifestItem
import de.retaildemo.core.Spec
import kotlinx.coroutines.delay

/** Vollbild-Demo: spielt Videos/Bilder in Schleife und zeigt zwischendurch die Gerätedaten. */
class DemoActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = demoApp
        if (!app.prefs.isConfigured) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                var askPin by remember { mutableStateOf(false) }
                DemoScreen(
                    app = app,
                    onCustomerTouch = ::exitToHome,
                    onAdminGesture = { askPin = true },
                )
                if (askPin) PinDialog(
                    correctPin = app.prefs.pin,
                    onDismiss = { askPin = false },
                    onSuccess = {
                        askPin = false
                        startActivity(Intent(this, SetupActivity::class.java))
                        finish()
                    },
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        demoApp.sync.playerStatus = "Demo läuft"
        demoApp.closeDemoCallback = { runOnUiThread { finish() } }
        demoApp.demoVisible = true
        // Volle Helligkeit: für dieses Fenster sofort, für das System (falls erlaubt) dauerhaft
        if (demoApp.prefs.maxBrightness) {
            window.attributes = window.attributes.apply {
                screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
            }
            Brightness.setMax(this)
        }
    }

    override fun onPause() {
        super.onPause()
        demoApp.demoVisible = false
        if (isFinishing) demoApp.closeDemoCallback = null
    }

    /** Kunde hat den Bildschirm berührt: Demo beenden und zum Startbildschirm wechseln. */
    private fun exitToHome() {
        demoApp.sync.playerStatus = "Kunde benutzt Gerät"
        startActivity(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }
}

private sealed interface Slide {
    data class Media(val item: ManifestItem) : Slide
    data object Specs : Slide
}

private fun buildSlides(m: Manifest?, available: (ManifestItem) -> Boolean): List<Slide> {
    if (m == null) return emptyList()
    val media = m.items.filter(available)
    val withSpecs = m.showSpecs && m.specsEveryN > 0
    val out = mutableListOf<Slide>()
    media.forEachIndexed { i, item ->
        out += Slide.Media(item)
        if (withSpecs && (i + 1) % m.specsEveryN == 0) out += Slide.Specs
    }
    // Pro Durchlauf mindestens einmal die Gerätedaten zeigen
    if (m.showSpecs && Slide.Specs !in out) out += Slide.Specs
    return out
}

@Composable
private fun DemoScreen(app: DemoApp, onCustomerTouch: () -> Unit, onAdminGesture: () -> Unit) {
    val manifest by app.sync.manifest.collectAsState()
    val contentVersion by app.sync.contentVersion.collectAsState()
    val slides = remember(manifest, contentVersion) { buildSlides(manifest, app.sync::isAvailable) }
    var index by remember { mutableIntStateOf(0) }
    val slide = slides.getOrNull(index % maxOf(1, slides.size))
    val next = { index = (index + 1) % maxOf(1, slides.size) }

    val context = androidx.compose.ui.platform.LocalContext.current
    val player = remember {
        ExoPlayer.Builder(context).build().apply { volume = 0f }
    }
    DisposableEffect(Unit) { onDispose { player.release() } }

    val onTouch by rememberUpdatedState(onCustomerTouch)
    val onAdmin by rememberUpdatedState(onAdminGesture)

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        when (slide) {
            null -> WaitingScreen(app)
            is Slide.Specs -> {
                SpecsSlide(manifest!!)
                LaunchedEffect(index, slides) {
                    delay(manifest!!.specsDurationS * 1000L)
                    if (slides.size > 1) next() else index = 0
                }
            }
            is Slide.Media -> {
                val item = slide.item
                val file = app.sync.localFile(item)
                if (item.isVideo) {
                    VideoSlide(player)
                    DisposableEffect(index, slides) {
                        val listener = object : Player.Listener {
                            override fun onPlaybackStateChanged(state: Int) {
                                if (state == Player.STATE_ENDED) next()
                            }
                            override fun onPlayerError(error: PlaybackException) = next()
                        }
                        player.addListener(listener)
                        player.repeatMode = if (slides.size == 1) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                        player.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)))
                        player.prepare()
                        player.play()
                        onDispose { player.removeListener(listener) }
                    }
                } else {
                    Crossfade(targetState = file, animationSpec = tween(600), label = "img") { f ->
                        AsyncImage(
                            model = f,
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    LaunchedEffect(index, slides) {
                        player.stop()
                        delay(item.durationS * 1000L)
                        if (slides.size > 1) next()
                    }
                }
            }
        }
        // Unsichtbare Ebene über allem, die jede Berührung erkennt (auch über dem Video)
        Box(
            Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    awaitEachGesture {
                        // Geheime Geste für dich: 3 Finger oben rechts 3 Sekunden halten -> PIN
                        fun inTopRight(p: Offset) = p.x > size.width / 2f && p.y < size.height / 2f
                        val down = awaitFirstDown(requireUnconsumed = false)
                        if (!inTopRight(down.position)) {
                            onTouch()
                            return@awaitEachGesture
                        }
                        // Kurz warten, ob insgesamt drei Finger oben rechts aufgesetzt werden
                        val threeFingers = withTimeoutOrNull(600) {
                            while (true) {
                                val pressed = awaitPointerEvent().changes.filter { it.pressed }
                                if (pressed.isEmpty()) return@withTimeoutOrNull false
                                if (pressed.size >= 3) return@withTimeoutOrNull pressed.all { inTopRight(it.position) }
                            }
                            @Suppress("UNREACHABLE_CODE") false
                        } ?: false
                        if (!threeFingers) {
                            onTouch()
                            return@awaitEachGesture
                        }
                        // Alle drei Finger müssen 3 Sekunden liegen bleiben
                        val lifted = withTimeoutOrNull(3_000) {
                            while (awaitPointerEvent().changes.count { it.pressed } >= 3) { /* weiter halten */ }
                            true
                        }
                        if (lifted == null) onAdmin() else onTouch()
                    }
                }
        )
    }
}

@Composable
private fun VideoSlide(player: ExoPlayer) {
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            PlayerView(ctx).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShutterBackgroundColor(android.graphics.Color.BLACK)
                this.player = player
            }
        },
    )
}

@Composable
private fun WaitingScreen(app: DemoApp) {
    val state by app.sync.state.collectAsState()
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Warte auf Inhalte vom Server …", color = Color.White, fontSize = 20.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(state, color = Color.Gray, fontSize = 14.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun SpecsSlide(m: Manifest) {
    val bg = Brush.linearGradient(listOf(Color(0xFF0B1026), Color(0xFF1E1B4B), Color(0xFF3B0764)))
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { visible = true }

    BoxWithConstraints(Modifier.fillMaxSize().background(bg).padding(horizontal = 28.dp, vertical = 40.dp)) {
        val landscape = maxWidth > maxHeight
        val specs = m.specs.filter { it.value.isNotBlank() }
        Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
        ) {
            AnimatedVisibility(visible, enter = fadeIn(tween(700)) + slideInVertically(tween(700)) { it / 3 }) {
                Column {
                    if (m.manufacturer.isNotBlank()) Text(
                        m.manufacturer.uppercase(),
                        color = Color(0xFFA5B4FC),
                        fontSize = 14.sp,
                        letterSpacing = 4.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        m.displayName,
                        color = Color.White,
                        fontSize = if (landscape) 40.sp else 36.sp,
                        lineHeight = if (landscape) 44.sp else 40.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(10.dp))
                    Box(
                        Modifier.width(56.dp).height(4.dp)
                            .background(Brush.horizontalGradient(listOf(Color(0xFF818CF8), Color(0xFFC084FC))))
                    )
                }
            }
            Spacer(Modifier.height(28.dp))
            val rows = if (landscape) specs.chunked(2) else specs.map { listOf(it) }
            rows.forEachIndexed { i, row ->
                var shown by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) { delay(300L + i * 120L); shown = true }
                AnimatedVisibility(shown, enter = fadeIn(tween(500)) + slideInVertically(tween(500)) { it / 2 }) {
                    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                        row.forEach { SpecCell(it, Modifier.weight(1f)) }
                        if (row.size == 1 && landscape) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun SpecCell(spec: Spec, modifier: Modifier) {
    Column(modifier.padding(end = 16.dp)) {
        if (spec.label.isNotBlank()) Text(
            spec.label.uppercase(),
            color = Color(0xFF94A3B8),
            fontSize = 11.sp,
            letterSpacing = 1.5.sp,
        )
        Text(spec.value, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun PinDialog(correctPin: String, onDismiss: () -> Unit, onSuccess: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Admin-PIN") },
        text = {
            OutlinedTextField(
                value = pin,
                onValueChange = { pin = it.filter(Char::isDigit); wrong = false },
                singleLine = true,
                isError = wrong,
                label = { Text(if (wrong) "Falsche PIN" else "PIN") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
        },
        confirmButton = {
            TextButton(onClick = { if (pin == correctPin) onSuccess() else wrong = true }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}
