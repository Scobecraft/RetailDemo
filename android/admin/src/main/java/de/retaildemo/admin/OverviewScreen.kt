package de.retaildemo.admin

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import de.retaildemo.core.HistoryPoint
import de.retaildemo.core.Overview
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/** Farben für Diagramme (geprüfte Palette, je für hell und dunkel). */
private class VizColors(dark: Boolean) {
    val s1 = if (dark) Color(0xFF3987E5) else Color(0xFF2A78D6)
    val s2 = if (dark) Color(0xFFD95926) else Color(0xFFEB6834)
    val s3 = if (dark) Color(0xFF199E70) else Color(0xFF1BAF7A)
    val s4 = if (dark) Color(0xFFC98500) else Color(0xFFEDA100)
    val off = if (dark) Color(0xFF4B505B) else Color(0xFFC3C6CC)
    val track = if (dark) Color(0xFF23324A) else Color(0xFFE3EDFB)
    val grid = if (dark) Color(0xFF2C313B) else Color(0xFFECEEF1)
    val warn = if (dark) Color(0xFFFAB219) else Color(0xFFB45309)
}

private const val GB = 1024.0 * 1024 * 1024
private fun gb(b: Long) = if (b >= 100 * GB) "%.0f GB".format(Locale.GERMAN, b / GB) else "%.1f GB".format(Locale.GERMAN, b / GB)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OverviewScreen(vm: AdminViewModel, modifier: Modifier) {
    val o by vm.overview.collectAsState()
    LaunchedEffect(Unit) {
        while (true) {
            if (vm.isConfigured) vm.refreshOverview()
            delay(15_000)
        }
    }
    val viz = VizColors(isSystemInDarkTheme())

    Column(modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Übersicht") },
            actions = { IconButton(onClick = { vm.refreshOverview() }) { Icon(Icons.Filled.Refresh, "Neu laden") } },
        )
        val ov = o
        if (ov == null) {
            Text(
                if (vm.isConfigured) "Lade …" else "Bitte zuerst unter „Einstellungen“ mit dem Server verbinden.",
                Modifier.padding(24.dp),
            )
            return
        }
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 12.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            KpiGrid(ov)
            StatusCard(ov, viz)
            LoadCard(ov, viz)
            ChartCard(ov.history, viz)
        }
    }
}

@Composable
private fun KpiGrid(o: Overview) {
    val d = o.devices
    val rel = o.appRelease?.takeIf { it.versionCode > 0 }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Kpi("Demo läuft", "${d.running}", "/ ${d.total}", "Geräte zeigen die Demo", Modifier.weight(1f), hero = true)
            Kpi("Verbunden", "${d.online}", "/ ${d.total}", if (d.offline > 0) "${d.offline} offline" else "alle online", Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Kpi("Geräte", "${d.total}", null, "${d.phones} Handys · ${d.laptops} Laptops", Modifier.weight(1f))
            Kpi(
                "Demo-App", rel?.versionName ?: "–", null,
                when {
                    rel == null -> "keine Version hochgeladen"
                    d.outdated > 0 -> "${d.outdated} Handy(s) veraltet"
                    else -> "alle Handys aktuell"
                },
                Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun Kpi(title: String, value: String, of: String?, note: String, modifier: Modifier, hero: Boolean = false) {
    val accent = Color(0xFFEE7F00)
    Card(
        modifier,
        colors = if (hero) CardDefaults.cardColors(containerColor = accent) else CardDefaults.cardColors(),
    ) {
        Box(
            if (hero) Modifier.background(Brush.linearGradient(listOf(accent, Color(0xFFC96A00)))) else Modifier
        ) {
            Column(Modifier.padding(14.dp).fillMaxWidth()) {
                val sub = if (hero) Color.White.copy(alpha = .85f) else MaterialTheme.colorScheme.onSurfaceVariant
                val main = if (hero) Color.White else MaterialTheme.colorScheme.onSurface
                Text(title, color = sub, style = MaterialTheme.typography.labelLarge)
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(value, color = main, fontSize = 34.sp, fontWeight = FontWeight.Bold, lineHeight = 38.sp)
                    if (of != null) Text(" $of", color = sub, fontSize = 16.sp, modifier = Modifier.padding(bottom = 5.dp))
                }
                Text(note, color = sub, style = MaterialTheme.typography.bodySmall, maxLines = 2)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatusCard(o: Overview, viz: VizColors) {
    val d = o.devices
    val parts = listOf(
        Triple("Demo läuft", d.running, viz.s1),
        Triple("Kunde benutzt", d.customer, viz.s2),
        Triple("Pausiert", d.paused, viz.s3),
        Triple("Ruhezeit", d.sleeping, viz.s4),
        Triple("Offline", d.offline, viz.off),
    )
    val darkInk = setOf("Ruhezeit", "Offline")
    Card {
        Column(Modifier.padding(16.dp).fillMaxWidth()) {
            Text("Was die Geräte gerade tun", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
            if (d.total == 0) {
                Text("Noch keine Geräte verbunden.")
            } else {
                // Ein Ganzes in Teile: segmentierter Balken, 2 dp Abstand zwischen den Teilen
                Row(Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(6.dp)), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    parts.filter { it.second > 0 }.forEach { (name, n, color) ->
                        Box(Modifier.weight(n.toFloat()).fillMaxSize().background(color), contentAlignment = Alignment.Center) {
                            if (n.toFloat() / d.total >= 0.1f) Text(
                                "$n", fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                                color = if (name in darkInk) Color(0xFF0B0B0B) else Color.White,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                parts.forEach { (name, n, color) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(color))
                        Spacer(Modifier.width(6.dp))
                        Text("$name ", style = MaterialTheme.typography.bodySmall)
                        Text("$n", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
                    }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 14.dp))
            Row {
                Column(Modifier.weight(1f)) {
                    MiniHeader("Online")
                    Line("📱 Handys", "${d.phonesOnline} / ${d.phones}")
                    Line("💻 Laptops", "${d.laptopsOnline} / ${d.laptops}")
                }
                Spacer(Modifier.width(16.dp))
                Column(Modifier.weight(1f)) {
                    MiniHeader("App-Versionen")
                    if (o.appVersions.isEmpty()) Line("–", "")
                    o.appVersions.forEach { (v, n) ->
                        Line("Version $v" + if (v == o.appRelease?.versionName) " ★" else "", "$n")
                    }
                }
            }
        }
    }
}

@Composable
private fun MiniHeader(text: String) = Text(
    text.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    letterSpacing = 0.6.sp, modifier = Modifier.padding(bottom = 4.dp),
)

@Composable
private fun Line(label: String, value: String) = Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
    Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
}

@Composable
private fun LoadCard(o: Overview, viz: VizColors) {
    val s = o.system
    Card {
        Column(Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                if (s.source == "proxmox") "Auslastung des Containers" else "Auslastung (Docker-Sicht)",
                style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Meter("CPU", s.cpuPercent, "${s.cpuCores} Kerne", viz)
            Meter("RAM", if (s.ramTotal > 0) 100.0 * s.ramUsed / s.ramTotal else 0.0, "${gb(s.ramUsed)} von ${gb(s.ramTotal)}", viz)
            Meter("Speicher", if (s.diskTotal > 0) 100.0 * s.diskUsed / s.diskTotal else 0.0, "${gb(s.diskUsed)} von ${gb(s.diskTotal)}", viz)
            Text(
                "Medien: ${o.media.count} Dateien, ${gb(o.media.bytes)}" +
                    (s.uptimeS?.let { " · läuft seit ${it / 86400} T. ${it % 86400 / 3600} Std." } ?: ""),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Meter(label: String, pct: Double, detail: String, viz: VizColors) {
    Column {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(label, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(8.dp))
            Text("${pct.roundToInt()} %", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(6.dp))
        Box(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp)).background(viz.track)) {
            Box(Modifier.fillMaxWidth((pct / 100).toFloat().coerceIn(0f, 1f)).fillMaxSize().clip(RoundedCornerShape(5.dp)).background(viz.s1))
        }
        if (pct >= 85) Text("⚠ Hohe Auslastung", color = viz.warn, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun ChartCard(history: List<HistoryPoint>, viz: VizColors) {
    Card {
        Column(Modifier.padding(16.dp).fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("CPU und RAM – letzte Stunde", style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                LegendDot("CPU", viz.s1); Spacer(Modifier.width(10.dp)); LegendDot("RAM", viz.s2)
            }
            Spacer(Modifier.height(8.dp))
            if (history.size < 2) Text("Der Verlauf füllt sich in den nächsten Minuten.", Modifier.padding(vertical = 24.dp))
            else HistoryChart(history, viz)
        }
    }
}

@Composable
private fun LegendDot(name: String, color: Color) = Row(verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(color))
    Spacer(Modifier.width(5.dp))
    Text(name, style = MaterialTheme.typography.bodySmall)
}

/** Liniendiagramm mit einer %-Achse (0–100). Antippen/Wischen zeigt die Werte zum Zeitpunkt. */
@Composable
private fun HistoryChart(history: List<HistoryPoint>, viz: VizColors) {
    var selected by remember(history) { mutableStateOf<Int?>(null) }
    val fmt = remember { SimpleDateFormat("HH:mm", Locale.GERMAN) }
    val textColor = MaterialTheme.colorScheme.onSurfaceVariant
    val density = LocalDensity.current
    val labelPaint = remember(textColor) {
        android.graphics.Paint().apply {
            isAntiAlias = true
            color = android.graphics.Color.argb((textColor.alpha * 255).toInt(), (textColor.red * 255).toInt(),
                (textColor.green * 255).toInt(), (textColor.blue * 255).toInt())
            textSize = with(density) { 11.sp.toPx() }
        }
    }
    val sel = selected?.let { history.getOrNull(it) }
    Text(
        sel?.let { "${fmt.format(Date(it.t * 1000))} · CPU ${it.cpu.roundToInt()} % · RAM ${it.ram.roundToInt()} %" }
            ?: "Aktuell: CPU ${history.last().cpu.roundToInt()} % · RAM ${history.last().ram.roundToInt()} %  (antippen für Details)",
        style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium,
    )
    Spacer(Modifier.height(6.dp))
    val t0 = history.first().t
    val t1 = history.last().t
    fun indexAt(xPx: Float, left: Float, width: Float): Int {
        val t = t0 + ((xPx - left) / width).coerceIn(0f, 1f) * (t1 - t0)
        return history.indices.minBy { abs(history[it].t - t) }
    }
    Canvas(
        Modifier.fillMaxWidth().height(180.dp)
            .pointerInput(history) {
                detectTapGestures { p -> val l = 34.dp.toPx(); selected = indexAt(p.x, l, size.width - l) }
            }
            .pointerInput(history) {
                detectDragGestures(onDragEnd = { selected = null }) { change, _ ->
                    val l = 34.dp.toPx(); selected = indexAt(change.position.x, l, size.width - l)
                }
            }
    ) {
        val left = 34.dp.toPx()
        val bottom = 18.dp.toPx()
        val w = size.width - left
        val h = size.height - bottom
        fun x(t: Long) = left + (t - t0).toFloat() / maxOf(1, t1 - t0) * w
        fun y(v: Double) = (1 - v.toFloat() / 100f) * h
        for (v in listOf(0, 25, 50, 75, 100)) {
            drawLine(viz.grid, Offset(left, y(v.toDouble())), Offset(size.width, y(v.toDouble())), strokeWidth = 1.dp.toPx())
            drawContext.canvas.nativeCanvas.drawText("$v %", 0f, y(v.toDouble()) + 4.dp.toPx(), labelPaint)
        }
        listOf(t0, t1).forEachIndexed { i, t ->
            val label = fmt.format(Date(t * 1000))
            val tw = labelPaint.measureText(label)
            drawContext.canvas.nativeCanvas.drawText(label, if (i == 0) left else size.width - tw, size.height - 2.dp.toPx(), labelPaint)
        }
        for ((color, value) in listOf(viz.s1 to { p: HistoryPoint -> p.cpu }, viz.s2 to { p: HistoryPoint -> p.ram })) {
            val path = Path()
            history.forEachIndexed { i, p -> if (i == 0) path.moveTo(x(p.t), y(value(p))) else path.lineTo(x(p.t), y(value(p))) }
            drawPath(path, color, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        sel?.let { p ->
            drawLine(textColor, Offset(x(p.t), 0f), Offset(x(p.t), h), strokeWidth = 1.dp.toPx(),
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
            for ((color, v) in listOf(viz.s1 to p.cpu, viz.s2 to p.ram)) {
                drawCircle(Color.White, 6.dp.toPx(), Offset(x(p.t), y(v)))
                drawCircle(color, 4.5.dp.toPx(), Offset(x(p.t), y(v)))
            }
        }
    }
}
