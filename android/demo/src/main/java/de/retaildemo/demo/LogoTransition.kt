package de.retaildemo.demo

import android.graphics.BitmapFactory
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.min

private val TOrange = Color(0xFFEE7F00)
private val TOrangeLight = Color(0xFFFF9A1F)
private val TInk = Color(0xFF16181D)
private val Smooth = CubicBezierEasing(0.65f, 0f, 0.35f, 1f)

private const val COVER_MS = 520
private const val HOLD_MS = 420
private const val REVEAL_MS = 520

/**
 * Übergang zwischen zwei Medien im expert-Stil: Eine orangefarbene Fläche mit dunklem Streifen fährt
 * schräg ins Bild, in der Mitte erscheint das Laden-Logo, hinter der Fläche wird der Inhalt gewechselt
 * ([onCovered]) und die Fläche fährt auf der anderen Seite wieder hinaus.
 * Jeder neue Wert von [key] (> 0) startet einen Übergang.
 */
@Composable
fun LogoTransition(key: Int, logo: ByteArray?, onCovered: () -> Unit) {
    val covered by rememberUpdatedState(onCovered)
    // 0 = aus, 0..1 hereinfahren, 1 = Bild verdeckt, 1..2 hinausfahren
    val p = remember { Animatable(0f) }
    val bitmap = remember(logo) { logo?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }.getOrNull() } }
    LaunchedEffect(key) {
        if (key <= 0) return@LaunchedEffect
        p.snapTo(0f)
        p.animateTo(1f, tween(COVER_MS, easing = Smooth))
        covered()
        delay(HOLD_MS.toLong())
        p.animateTo(2f, tween(REVEAL_MS, easing = Smooth))
        p.snapTo(0f)
    }
    LogoTransitionFrame(p.value, bitmap)
}

/** Ein Bild des Übergangs: [v] 0..1 hereinfahren, 1 verdeckt, 1..2 hinausfahren. */
@Composable
fun LogoTransitionFrame(v: Float, bitmap: androidx.compose.ui.graphics.ImageBitmap?) {
    if (v <= 0f || v >= 2f) return
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wPx = constraints.maxWidth.toFloat()
        // Fläche: von links herein (−1 → 0), dann nach rechts hinaus (0 → +1); Streifen läuft leicht voraus
        val shift = v - 1f
        Canvas(Modifier.fillMaxSize()) {
            val skew = size.height * 0.14f
            val travel = size.width + skew * 2
            // schräges Band; bei offset 0 deckt es den Bildschirm genau ganz ab
            fun band(offset: Float, brush: Brush) {
                val x = offset * travel
                val path = Path().apply {
                    moveTo(x, 0f); lineTo(x + size.width + skew * 2, 0f)
                    lineTo(x + size.width, size.height); lineTo(x - skew * 2, size.height); close()
                }
                drawPath(path, brush)
            }
            // dunkler Streifen läuft beim Hereinfahren voraus und beim Hinausfahren hinterher
            band(shift * 0.9f, Brush.linearGradient(listOf(TInk, Color(0xFF2A2E36))))
            band(shift, Brush.linearGradient(listOf(TOrange, TOrangeLight), Offset.Zero, Offset(size.width, size.height)))
            // feine helle Linie an der vorderen Kante des orangen Bands
            val x = shift * travel
            if (v < 1f) drawLine(Color.White.copy(alpha = 0.6f), Offset(x + size.width + skew * 2, 0f), Offset(x + size.width, size.height), 3.dp.toPx())
            else drawLine(Color.White.copy(alpha = 0.6f), Offset(x, 0f), Offset(x - skew * 2, size.height), 3.dp.toPx())
        }
        // Logo: springt beim Verdecken auf, verschwindet beim Hinausfahren
        val logoT = when {
            v < 0.55f -> 0f
            v <= 1f -> (v - 0.55f) / 0.45f
            v < 1.45f -> 1f - (v - 1f) / 0.45f
            else -> 0f
        }.coerceIn(0f, 1f)
        if (logoT > 0f) {
            val pop = 0.7f + 0.3f * logoT + 0.08f * (1f - abs(2f * logoT - 1f)) // kleiner Überschwinger
            val side = min(maxWidth.value, maxHeight.value)
            Box(
                Modifier.align(Alignment.Center)
                    .graphicsLayer { scaleX = pop; scaleY = pop; alpha = logoT; translationX = (1f - logoT) * wPx * 0.04f * (if (v > 1f) 1f else -1f) }
                    .clip(RoundedCornerShape(18.dp))
                    // dunkle Karte: das Logo hat weiße Schrift (wie in der Druckmonitor-Ansicht)
                    .background(TInk)
                    .border(2.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(18.dp))
                    .padding(horizontal = (side * 0.06f).dp, vertical = (side * 0.035f).dp),
            ) {
                if (bitmap != null) Image(bitmap, "Logo", Modifier.height((side * 0.13f).dp), contentScale = ContentScale.Fit)
                else Text("expert", color = TOrange, fontWeight = FontWeight.Black, fontSize = (side * 0.09f).sp)
            }
        }
    }
}
