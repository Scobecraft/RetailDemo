package de.retaildemo.demo

import android.graphics.BitmapFactory
import android.os.Build
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import de.retaildemo.core.DruckPromo
import de.retaildemo.core.DruckStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.LocalTime
import java.util.Locale
import kotlin.math.roundToInt

// expert-Farben: kräftiges Orange auf Anthrazit, weiße, fette Schrift
private val Orange = Color(0xFFEE7F00)
private val OrangeDark = Color(0xFFC96A00)
private val Ink = Color(0xFF16181D)
private val Panel = Color(0xFF1F2229)
private val Muted = Color(0xFF9AA1AE)

private const val INTRO_MS = 3_600L

/**
 * Einblendung "3D-Druck live": animiertes Intro im expert-Stil, danach für [DruckPromo.durationS]
 * Sekunden das Live-Bild des Druckers mit Fortschritt, Restzeit und Druckerwerten.
 * Hört der Druck zwischendurch auf, endet die Einblendung sofort.
 */
@Composable
fun DruckPromoSlide(app: DemoApp, promo: DruckPromo, onDone: () -> Unit) {
    val done by rememberUpdatedState(onDone)
    var phase by remember { mutableStateOf(0) } // 0 = Intro, 1 = Live
    var status by remember { mutableStateOf<DruckStatus?>(null) }
    var frame by remember { mutableStateOf<ImageBitmap?>(null) }
    val logo = remember {
        app.druck.logo?.let { b -> runCatching { BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap() }.getOrNull() }
    }

    LaunchedEffect(Unit) {
        val api = app.druck.api()
        // Druckerwerte alle 2 s; watch=1 sorgt dafür, dass der PC flüssig Bilder schickt
        launch {
            while (isActive) {
                val s = runCatching { api.druckStatus(watch = true) }.getOrNull()
                if (s != null && !s.active) { done(); return@launch }
                if (s != null) status = s
                delay(2_000)
            }
        }
        // Kamerabilder (wartet serverseitig auf das nächste Bild)
        launch {
            var seq = 0L
            while (isActive) {
                val r = runCatching { api.druckFrame(seq) }.getOrNull()
                if (r == null) { delay(300); continue }
                seq = r.first
                // Entpacken nicht im UI-Thread
                withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(r.second, 0, r.second.size)?.asImageBitmap() }
                    ?.let { frame = it }
            }
        }
        delay(INTRO_MS)
        phase = 1
        delay(promo.durationS.coerceIn(3, 120) * 1000L)
        done()
    }

    Box(Modifier.fillMaxSize().background(Ink)) {
        Crossfade(targetState = phase, animationSpec = tween(700), label = "druck") { p ->
            if (p == 0) PromoIntro(promo, logo) else PromoLive(promo, status, frame, logo)
        }
    }
}

// ---------------------------------------------------------------- Intro

@Composable
private fun PromoIntro(promo: DruckPromo, logo: ImageBitmap?) {
    val sweep = remember { Animatable(-1.2f) }
    LaunchedEffect(Unit) { sweep.animateTo(0f, tween(650, easing = FastOutSlowInEasing)) }
    var show by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { delay(350); show = true }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val landscape = maxWidth > maxHeight
        val scale = (minOf(maxWidth, maxHeight) / 400.dp).coerceIn(0.85f, 2.2f)
        // Orangefarbene Fläche fährt schräg ins Bild, dahinter ein dunklerer Streifen
        Canvas(Modifier.fillMaxSize()) {
            val shift = sweep.value * size.width
            val skew = size.height * 0.35f
            val stripe = androidx.compose.ui.graphics.Path().apply {
                moveTo(shift - skew, 0f); lineTo(shift + size.width * 1.1f, 0f)
                lineTo(shift + size.width * 1.1f - skew, size.height); lineTo(shift - skew * 2, size.height); close()
            }
            drawPath(stripe, OrangeDark)
            val main = androidx.compose.ui.graphics.Path().apply {
                moveTo(shift * 1.15f, 0f); lineTo(shift * 1.15f + size.width * 1.2f, 0f)
                lineTo(shift * 1.15f + size.width * 1.2f - skew, size.height); lineTo(shift * 1.15f - skew, size.height); close()
            }
            drawPath(main, Brush.linearGradient(listOf(Orange, Color(0xFFFF9A1F)), Offset.Zero, Offset(size.width, size.height)))
        }
        Column(
            Modifier.fillMaxSize().padding(horizontal = (28 * scale).dp, vertical = (36 * scale).dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = if (landscape) Alignment.Start else Alignment.CenterHorizontally,
        ) {
            AnimatedVisibility(show, enter = fadeIn(tween(400)) + scaleIn(tween(500), initialScale = 0.7f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (logo != null) Box(
                        Modifier.clip(RoundedCornerShape((14 * scale).dp)).background(Color.White)
                            .padding(horizontal = (14 * scale).dp, vertical = (8 * scale).dp)
                    ) {
                        Image(logo, null, Modifier.height((34 * scale).dp), contentScale = ContentScale.Fit)
                    }
                    if (logo != null) Spacer(Modifier.width((12 * scale).dp))
                    LivePill(scale)
                }
            }
            Spacer(Modifier.height((26 * scale).dp))
            PrinterLayers(Modifier.size((96 * scale).dp, (70 * scale).dp))
            Spacer(Modifier.height((22 * scale).dp))
            val words = promo.title.ifBlank { "Wir haben jetzt auch 3D-Drucker!" }
            AnimatedVisibility(show, enter = fadeIn(tween(500, 250)) + slideInVertically(tween(600, 250)) { it / 2 }) {
                Text(
                    words, color = Color.White, fontWeight = FontWeight.Black,
                    fontSize = (34 * scale).sp, lineHeight = (38 * scale).sp,
                    textAlign = if (landscape) TextAlign.Start else TextAlign.Center,
                )
            }
            Spacer(Modifier.height((12 * scale).dp))
            AnimatedVisibility(show, enter = fadeIn(tween(500, 700)) + slideInHorizontally(tween(600, 700)) { -it / 4 }) {
                Box(Modifier.clip(RoundedCornerShape(8.dp)).background(Ink).padding(horizontal = (14 * scale).dp, vertical = (8 * scale).dp)) {
                    Text(
                        promo.subtitle.ifBlank { "Schaut doch gerne zu!" }, color = Color.White,
                        fontWeight = FontWeight.SemiBold, fontSize = (17 * scale).sp,
                        textAlign = if (landscape) TextAlign.Start else TextAlign.Center,
                    )
                }
            }
        }
    }
}

@Composable
private fun LivePill(scale: Float) {
    val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
        0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "p",
    )
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(Color(0xFFDC2626)).padding(horizontal = (12 * scale).dp, vertical = (6 * scale).dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size((9 * scale).dp).alpha(pulse).clip(CircleShape).background(Color.White))
        Spacer(Modifier.width((7 * scale).dp))
        Text("LIVE · 3D-DRUCK", color = Color.White, fontWeight = FontWeight.Bold, fontSize = (13 * scale).sp, letterSpacing = 1.5.sp)
    }
}

/** Kleine Animation: Schicht für Schicht wächst ein Objekt, darüber fährt die Düse hin und her. */
@Composable
private fun PrinterLayers(modifier: Modifier) {
    val t by rememberInfiniteTransition(label = "layers").animateFloat(
        0f, 1f, infiniteRepeatable(tween(2_400, easing = LinearEasing)), label = "t",
    )
    Canvas(modifier) {
        val layers = 7
        val lh = size.height * 0.75f / layers
        val grown = (t * (layers + 1)).toInt().coerceAtMost(layers)
        for (i in 0 until grown) {
            val w = size.width * (0.9f - i * 0.07f)
            drawRoundRect(
                Color.White.copy(alpha = 0.55f + 0.45f * i / layers),
                topLeft = Offset((size.width - w) / 2, size.height - (i + 1) * lh),
                size = Size(w, lh * 0.8f), cornerRadius = CornerRadius(lh / 2),
            )
        }
        val y = size.height - (grown + 1) * lh - lh * 0.4f
        val x = size.width * (0.15f + 0.7f * (0.5f + 0.5f * kotlin.math.sin(t * 6.283f * 3)))
        val nozzle = androidx.compose.ui.graphics.Path().apply {
            moveTo(x - lh * 1.1f, y - lh * 1.4f); lineTo(x + lh * 1.1f, y - lh * 1.4f); lineTo(x, y + lh * 0.2f); close()
        }
        drawPath(nozzle, Ink)
    }
}

// ---------------------------------------------------------------- Live-Bild mit Werten

@Composable
private fun PromoLive(promo: DruckPromo, s: DruckStatus?, frame: ImageBitmap?, logo: ImageBitmap?) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val landscape = maxWidth > maxHeight
        val small = maxHeight < 720.dp
        val scale = (minOf(maxWidth, maxHeight) / 400.dp).coerceIn(0.8f, 2f)
        // Hintergrund: dasselbe Bild groß und unscharf (ab Android 12), sonst abgedunkelt
        if (frame != null) Image(
            frame, null, Modifier.fillMaxSize()
                .then(if (Build.VERSION.SDK_INT >= 31) Modifier.blur(28.dp) else Modifier)
                .alpha(if (Build.VERSION.SDK_INT >= 31) 0.45f else 0.18f),
            contentScale = ContentScale.Crop,
        )
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0x99000000), Color(0xDD0E0F12)))))

        val pad = (16 * scale).dp
        if (landscape) {
            Row(Modifier.fillMaxSize().padding(pad), horizontalArrangement = Arrangement.spacedBy(pad)) {
                Column(Modifier.weight(1.65f).fillMaxHeight(), verticalArrangement = Arrangement.Center) {
                    LiveHeader(logo, scale)
                    Spacer(Modifier.height((10 * scale).dp))
                    CameraBox(frame, Modifier.fillMaxWidth().weight(1f, fill = false), scale, heightFirst = true)
                }
                StatsPanel(s, scale, Modifier.weight(1f).fillMaxHeight(), maxTiles = 8)
            }
        } else {
            Column(Modifier.fillMaxSize().padding(pad), verticalArrangement = Arrangement.spacedBy((12 * scale).dp)) {
                LiveHeader(logo, scale)
                CameraBox(frame, Modifier.fillMaxWidth(), scale)
                StatsPanel(s, scale, Modifier.fillMaxWidth().weight(1f), maxTiles = if (small) 4 else 8)
            }
        }
        // Restzeit der Einblendung als dünner Balken unten
        val shrink = remember { Animatable(1f) }
        LaunchedEffect(Unit) { shrink.animateTo(0f, tween(promo.durationS.coerceIn(3, 120) * 1000, easing = LinearEasing)) }
        Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(shrink.value).height(4.dp).background(Orange))
    }
}

@Composable
private fun LiveHeader(logo: ImageBitmap?, scale: Float) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        LivePill(scale * 0.9f)
        Spacer(Modifier.width((10 * scale).dp))
        Text("Gerade in unserem 3D-Drucker", color = Color.White, fontWeight = FontWeight.Bold,
            fontSize = (16 * scale).sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (logo != null) Box(
            Modifier.clip(RoundedCornerShape(8.dp)).background(Color.White).padding(horizontal = 8.dp, vertical = 4.dp)
        ) { Image(logo, null, Modifier.height((20 * scale).dp), contentScale = ContentScale.Fit) }
    }
}

@Composable
private fun CameraBox(frame: ImageBitmap?, modifier: Modifier, scale: Float, heightFirst: Boolean = false) {
    val ratio = frame?.let { it.width.toFloat() / it.height } ?: (16f / 9f)
    Box(
        modifier.aspectRatio(ratio, matchHeightConstraintsFirst = heightFirst)
            .clip(RoundedCornerShape((16 * scale).dp)).background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        if (frame != null) Image(frame, "Live-Bild des 3D-Druckers", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        else Text("Verbinde mit der Kamera …", color = Muted, fontSize = (14 * scale).sp)
        // Orangefarbene Ecken wie in der Druckmonitor-Ansicht
        Canvas(Modifier.fillMaxSize()) {
            val l = 26 * scale * density / 2.6f
            val w = 3 * density
            listOf(Offset(0f, 0f) to Offset(1f, 1f), Offset(size.width, 0f) to Offset(-1f, 1f),
                Offset(0f, size.height) to Offset(1f, -1f), Offset(size.width, size.height) to Offset(-1f, -1f)).forEach { (o, d) ->
                drawLine(Orange, o, Offset(o.x + d.x * l, o.y), w)
                drawLine(Orange, o, Offset(o.x, o.y + d.y * l), w)
            }
        }
    }
}

@Composable
private fun StatsPanel(s: DruckStatus?, scale: Float, modifier: Modifier, maxTiles: Int) {
    Column(
        modifier.clip(RoundedCornerShape((18 * scale).dp)).background(Panel.copy(alpha = 0.92f)).padding((16 * scale).dp),
        verticalArrangement = Arrangement.spacedBy((10 * scale).dp),
    ) {
        Text("AKTUELLER DRUCK", color = Orange, fontWeight = FontWeight.Bold, fontSize = (11 * scale).sp, letterSpacing = 2.sp)
        Text(s?.model?.ifBlank { null } ?: "3D-Druck", color = Color.White, fontWeight = FontWeight.Black,
            fontSize = (22 * scale).sp, lineHeight = (26 * scale).sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        // Fortschritt
        val prog = (s?.progress ?: 0.0).toFloat().coerceIn(0f, 1f)
        val shown by animateFloatAsState(prog, tween(1_200, easing = FastOutSlowInEasing), label = "prog")
        Row(verticalAlignment = Alignment.Bottom) {
            Text("${(shown * 100).roundToInt()} %", color = Color.White, fontWeight = FontWeight.Black, fontSize = (34 * scale).sp)
            Spacer(Modifier.width(10.dp))
            s?.remainingS?.takeIf { it > 0 }?.let {
                Text("noch ${if (s.remainingEstimated) "ca. " else ""}${fmtDur(it)}", color = Muted,
                    fontSize = (14 * scale).sp, modifier = Modifier.padding(bottom = (6 * scale).dp))
            }
        }
        Box(Modifier.fillMaxWidth().height((10 * scale).dp).clip(RoundedCornerShape(50)).background(Color(0xFF2E323B))) {
            Box(Modifier.fillMaxWidth(shown).fillMaxHeight().clip(RoundedCornerShape(50))
                .background(Brush.horizontalGradient(listOf(OrangeDark, Orange, Color(0xFFFFB04D)))))
        }
        // Werte, nacheinander eingeblendet
        val tiles = buildList {
            s?.remainingS?.takeIf { it > 0 }?.let { add("Fertig um" to LocalTime.now().plusSeconds(it.toLong()).let { t -> "%02d:%02d Uhr".format(t.hour, t.minute) }) }
            if ((s?.layers ?: 0) > 0) add("Schicht" to "${s!!.layer} / ${s.layers}")
            s?.nozzle?.let { add("Düse" to "${it.roundToInt()} °C" + (s.nozzleTarget?.takeIf { t -> t > 0 }?.let { t -> " / ${t.roundToInt()}" } ?: "")) }
            s?.bed?.let { add("Druckbett" to "${it.roundToInt()} °C" + (s.bedTarget?.takeIf { t -> t > 0 }?.let { t -> " / ${t.roundToInt()}" } ?: "")) }
            s?.speedMms?.let { add("Geschwindigkeit" to "${it.roundToInt()} mm/s") }
            s?.elapsedS?.takeIf { it > 0 }?.let { add("Läuft seit" to fmtDur(it)) }
            if (!s?.filament.isNullOrBlank()) add("Filament" to s!!.filament)
            s?.layerHeight?.let { add("Schichthöhe" to String.format(Locale.GERMAN, "%.2f mm", it)) }
            s?.fan?.let { add("Lüfter" to "${it.roundToInt()} %") }
        }
        tiles.take(maxTiles).chunked(2).forEachIndexed { row, pair ->
            var visible by remember { mutableStateOf(false) }
            LaunchedEffect(Unit) { delay(200L + row * 140L); visible = true }
            AnimatedVisibility(visible, enter = fadeIn(tween(450)) + slideInVertically(tween(450)) { it / 2 }) {
                Row(horizontalArrangement = Arrangement.spacedBy((10 * scale).dp)) {
                    pair.forEach { (k, v) -> StatTile(k, v, scale, Modifier.weight(1f)) }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
        s?.filamentColor?.let { parseColor(it) }?.let { c ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size((12 * scale).dp).clip(CircleShape).background(c))
                Spacer(Modifier.width(6.dp))
                Text("Filamentfarbe", color = Muted, fontSize = (12 * scale).sp)
            }
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, scale: Float, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape((12 * scale).dp)).background(Color(0xFF282C35)).padding((10 * scale).dp)) {
        Text(label.uppercase(), color = Muted, fontSize = (10 * scale).sp, letterSpacing = 1.sp, maxLines = 1)
        Text(value, color = Color.White, fontWeight = FontWeight.Bold, fontSize = (16 * scale).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private fun fmtDur(sec: Double): String {
    val s = sec.roundToInt()
    val h = s / 3600
    val m = s % 3600 / 60
    return if (h > 0) "$h Std. $m Min." else "$m Min."
}

private fun parseColor(hex: String): Color? = runCatching {
    val h = hex.trim().removePrefix("#")
    if (h.length != 6 && h.length != 8) return null
    Color(android.graphics.Color.parseColor("#$h"))
}.getOrNull()
