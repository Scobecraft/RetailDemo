package de.retaildemo.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import de.retaildemo.core.Device
import de.retaildemo.core.DevicePatch
import de.retaildemo.core.Playlist
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(vm: AdminViewModel, modifier: Modifier) {
    val devices by vm.devices.collectAsState()
    val overview by vm.overview.collectAsState()
    val release = overview?.appRelease?.takeIf { it.versionCode > 0 }
    val playlists by vm.playlists.collectAsState()
    var editingId by remember { mutableStateOf<String?>(null) }
    var showStale by remember { mutableStateOf(false) }
    var confirmRemoveStale by remember { mutableStateOf(false) }
    val (active, stale) = devices.partition { d ->
        d.online || (d.lastSeen ?: 0.0) > System.currentTimeMillis() / 1000.0 - 24 * 3600
    }

    // Liste aktualisieren, solange dieser Tab offen ist
    LaunchedEffect(Unit) {
        while (true) {
            if (vm.isConfigured) { vm.refreshDevices(); vm.refreshOverview() }
            delay(20_000)
        }
    }

    Column(modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Geräte") },
            actions = {
                TextButton(onClick = { vm.syncAll() }, enabled = devices.isNotEmpty()) { Text("Alle aktualisieren") }
                IconButton(onClick = { vm.refreshDevices() }) { Icon(Icons.Filled.Refresh, "Neu laden") }
            },
        )
        LazyColumn(
            contentPadding = PaddingValues(12.dp, 0.dp, 12.dp, 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (devices.isEmpty()) item {
                Text(
                    "Noch keine Geräte. Installiere die Demo-App auf einem Gerät und trage dort Server-Adresse und Geräte-Token ein – es erscheint dann automatisch hier.",
                    Modifier.padding(12.dp),
                )
            }
            items(active, key = { it.id }) { d -> DeviceCard(d, release, overview?.rolledOut == true) { editingId = d.id } }
            if (stale.isNotEmpty()) {
                item {
                    Row(
                        Modifier.fillMaxWidth().clickable { showStale = !showStale }.padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${if (showStale) "▾" else "▸"} Länger als 24 Std. offline (${stale.size})",
                            style = MaterialTheme.typography.titleSmall,
                            modifier = Modifier.weight(1f),
                        )
                        if (showStale) TextButton(onClick = { confirmRemoveStale = true }) {
                            Text("Alle entfernen", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                if (showStale) items(stale, key = { it.id }) { d -> DeviceCard(d, release, overview?.rolledOut == true) { editingId = d.id } }
            }
        }
    }

    if (confirmRemoveStale) AlertDialog(
        onDismissRequest = { confirmRemoveStale = false },
        title = { Text("${stale.size} Gerät(e) entfernen?") },
        text = { Text("Wahrscheinlich ist die Demo-App dort nicht mehr installiert. Taucht ein Gerät wieder auf, erscheint es automatisch neu.") },
        confirmButton = {
            TextButton(onClick = { stale.forEach { vm.deleteDevice(it.id) }; confirmRemoveStale = false }) {
                Text("Entfernen", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = { confirmRemoveStale = false }) { Text("Abbrechen") } },
    )

    devices.firstOrNull { it.id == editingId }?.let { d ->
        DeviceDialog(vm, d, playlists) { editingId = null }
    }
}

@Composable
private fun DeviceCard(d: Device, release: de.retaildemo.core.AppRelease?, rolledOut: Boolean, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(12.dp).background(
                    if (d.online) Color(0xFF22C55E) else Color(0xFF9CA3AF), CircleShape
                )
            )
            Spacer(Modifier.width(10.dp))
            Text(if (d.isLaptop) "💻" else "📱", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(d.effectiveName.ifBlank { d.model ?: d.id }, fontWeight = FontWeight.SemiBold)
                Text(
                    listOfNotNull(d.manufacturer, d.model, d.androidVersion).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = Color.Gray,
                )
                Text("Playlist: ${d.playlistName}", style = MaterialTheme.typography.bodySmall)
                Text(
                    buildString {
                        append(if (d.online) "Online" else "Offline · zuletzt ${ago(d.lastSeen)}")
                        d.status?.let { append(" · $it") }
                        d.battery?.let { append(" · 🔋 $it %") }
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    when {
                        d.lastError != null -> "⚠️ ${d.lastError}"
                        d.syncRequested -> "⏳ Aktualisierung angefordert"
                        d.upToDate -> "✅ Inhalte aktuell"
                        else -> "🔄 Änderungen beim nächsten Abgleich (zuletzt ${ago(d.lastSync)})"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (d.lastError != null) MaterialTheme.colorScheme.error else Color.Unspecified,
                )
                appStatus(d, release, rolledOut)?.let { (text, highlight) ->
                    Text(
                        text, style = MaterialTheme.typography.bodySmall,
                        color = if (highlight) Color(0xFFEE7F00) else Color.Unspecified,
                        fontWeight = if (highlight) FontWeight.SemiBold else null,
                    )
                }
                theftLine(d)?.let { (text, col) ->
                    Text(text, style = MaterialTheme.typography.bodySmall, color = col, fontWeight = FontWeight.SemiBold)
                }
                readinessLine(d)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = Color(0xFFD97706))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeviceDialog(vm: AdminViewModel, d: Device, playlists: List<Playlist>, onDismiss: () -> Unit) {
    var name by remember(d.id) { mutableStateOf(d.displayName) }
    var specs by remember(d.id) { mutableStateOf(d.customSpecs) }
    var showSpecs by remember(d.id) { mutableStateOf(d.showSpecs) }
    var playlistId by remember(d.id) { mutableStateOf(d.playlistId) }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Gerät entfernen?") },
            text = { Text("Das Gerät verschwindet aus der Liste. Läuft die Demo-App noch, meldet es sich beim nächsten Kontakt neu an.") },
            confirmButton = {
                TextButton(onClick = { vm.deleteDevice(d.id); onDismiss() }) {
                    Text("Entfernen", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Abbrechen") } },
        )
        return
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(d.effectiveName.ifBlank { "Gerät" }) },
        text = {
            Column(
                Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    name, { name = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Angezeigter Name") },
                    placeholder = { Text(d.marketingName ?: d.model ?: "") },
                )
                ExposedDropdownMenuBox(expanded = menuOpen, onExpandedChange = { menuOpen = it }) {
                    val label = playlists.firstOrNull { it.id == playlistId }?.name ?: "Standard-Playlist"
                    OutlinedTextField(
                        value = label, onValueChange = {}, readOnly = true,
                        label = { Text("Playlist") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(menuOpen) },
                        modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
                    )
                    ExposedDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Standard-Playlist") }, onClick = { playlistId = null; menuOpen = false })
                        playlists.forEach { pl ->
                            DropdownMenuItem(text = { Text(pl.name) }, onClick = { playlistId = pl.id; menuOpen = false })
                        }
                    }
                }
                SwitchRow(
                    "Gerätedaten anzeigen",
                    if (d.isLaptop) "Animierte Spec-Seite zwischendurch einblenden" else "Name & Specs zwischendurch einblenden",
                    showSpecs,
                ) { showSpecs = it }
                OutlinedTextField(
                    specs, { specs = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 4,
                    label = { Text("Eigene Specs (leer = automatisch)") },
                    placeholder = {
                        Text(
                            if (d.isLaptop) "Prozessor: Intel Core Ultra 7\nArbeitsspeicher: 16 GB\nPreis: 1.299 €"
                            else "Display: 6,8\" AMOLED\nKamera: 200 MP\nPreis: 1.299 €"
                        )
                    },
                    supportingText = { Text("Eine Zeile pro Eintrag, Format „Bezeichnung: Wert“") },
                )
                if (d.autoSpecs.isNotEmpty()) {
                    Text("Automatisch erkannt:", style = MaterialTheme.typography.labelLarge)
                    d.autoSpecs.forEach {
                        Text("${it.label}: ${it.value}", style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = { specs = d.autoSpecs.joinToString("\n") { "${it.label}: ${it.value}" } }) {
                        Text("Als Vorlage übernehmen")
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { vm.syncNow(d.id) }) { Text("Jetzt aktualisieren") }
                    TextButton(onClick = { confirmDelete = true }) {
                        Text("Entfernen", color = MaterialTheme.colorScheme.error)
                    }
                }
                HorizontalInfo(d)
                if (!d.isLaptop) {
                    Text("Diebstahlschutz", style = MaterialTheme.typography.labelLarge)
                    Text(theftStatusText(d), style = MaterialTheme.typography.bodySmall,
                        color = if (d.theftLocked || d.theftMissing) MaterialTheme.colorScheme.error else Color.Gray)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (d.theftLocked) {
                            Button(onClick = { vm.theftLock(d.id, false); onDismiss() }) { Text("Entsperren") }
                        } else {
                            Button(onClick = { vm.theftLock(d.id, true); onDismiss() }) { Text("Sperren") }
                            OutlinedButton(onClick = { vm.theftTest(d.id); onDismiss() }) { Text("Test") }
                        }
                    }
                }
                Text(
                    (if (d.isLaptop) "Laptop · " else "") +
                        "ID ${d.id.take(8)} · App ${d.appVersion ?: "?"}" + (d.ip?.let { " · IP $it" } ?: ""),
                    style = MaterialTheme.typography.bodySmall, color = Color.Gray,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                vm.updateDevice(
                    d.id,
                    DevicePatch(
                        displayName = name,
                        customSpecs = specs,
                        showSpecs = showSpecs,
                        playlistId = playlistId,
                        clearPlaylist = playlistId == null,
                    ),
                )
                onDismiss()
            }) { Text("Speichern") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

@Composable
private fun HorizontalInfo(d: Device) {
    if (!d.isLaptop) {
        Text("IMEI: ${d.imei ?: "—"}", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
        Text("Seriennummer: ${d.serial ?: "—"}", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
    }
    Text("Installiert: ${fmtDate(d.createdAt)} · Betriebsstunden: ${fmtDur(d.operatingS)}",
        style = MaterialTheme.typography.bodySmall, color = Color.Gray)
    readinessLine(d)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Color(0xFFD97706)) }
}

private val RDY_LABEL = linkedMapOf(
    "loc_fine" to "Standort-Berechtigung", "loc_background" to "Standort „immer\u201c", "loc_on" to "Standort an",
    "wifi" to "WLAN an", "battery_unrestricted" to "Akku-Optimierung aus", "accessibility" to "Bedienungshilfe",
    "notifications" to "Benachrichtigungen", "camera" to "Kamera")

private fun readinessLine(d: Device): String? {
    val r = d.readiness ?: return null
    val miss = mutableListOf<String>()
    if (!r.locFine) miss += RDY_LABEL["loc_fine"]!!
    if (!r.locBackground) miss += RDY_LABEL["loc_background"]!!
    if (!r.locOn) miss += RDY_LABEL["loc_on"]!!
    if (!r.wifi) miss += RDY_LABEL["wifi"]!!
    if (!r.batteryUnrestricted) miss += RDY_LABEL["battery_unrestricted"]!!
    if (!r.accessibility) miss += RDY_LABEL["accessibility"]!!
    if (!r.notifications) miss += RDY_LABEL["notifications"]!!
    if (!r.camera) miss += RDY_LABEL["camera"]!!
    return if (miss.isEmpty()) null else "⚠️ Einrichtung fehlt: " + miss.joinToString(", ")
}

private fun theftLine(d: Device): Pair<String, Color>? = when {
    d.theftTest -> "🔒 Testsperre aktiv" to Color(0xFFEE7F00)
    d.theftLocked -> "🔒 Gesperrt" to Color(0xFFE5484D)
    d.theftMissing -> "⚠️ Verschwunden (möglicher Diebstahl)" to Color(0xFFE5484D)
    else -> null
}

private fun theftStatusText(d: Device): String = when {
    d.theftTest -> "Testsperre aktiv (endet von selbst)"
    d.theftLocked -> "Gesperrt – Gerät ist unbrauchbar gemacht"
    d.theftMissing -> "Verschwunden – meldet sich nicht mehr"
    else -> "Nicht gesperrt"
}

private fun fmtDate(epochS: Double?): String {
    if (epochS == null || epochS <= 0) return "unbekannt"
    return java.text.SimpleDateFormat("dd.MM.yyyy", java.util.Locale.GERMANY).format(java.util.Date((epochS * 1000).toLong()))
}

private fun fmtDur(sec: Double): String {
    if (sec < 60) return "< 1 Std."
    val h = sec / 3600.0
    return when {
        h < 1 -> "${(sec / 60).toInt()} Min."
        h < 100 -> String.format(java.util.Locale.GERMANY, "%.1f Std.", h)
        else -> "${h.toInt()} Std."
    }
}

private fun ago(epochS: Double?): String {
    if (epochS == null) return "nie"
    val s = (System.currentTimeMillis() / 1000.0 - epochS).toLong()
    return when {
        s < 60 -> "gerade eben"
        s < 3600 -> "vor ${s / 60} Min."
        s < 86400 -> "vor ${s / 3600} Std."
        else -> "vor ${s / 86400} Tagen"
    }
}

/** App-Version eines Handys im Vergleich zur Version auf dem Server (Text, hervorheben?). */
private fun appStatus(d: Device, release: de.retaildemo.core.AppRelease?, rolledOut: Boolean): Pair<String, Boolean>? {
    if ((d.platform ?: "android") != "android" || d.appVersion.isNullOrBlank()) return null
    val base = "App ${d.appVersion}"
    val installed = d.appVersionCode ?: return base to false
    if (release == null) return base to false
    return when {
        installed >= release.versionCode -> "$base · ✅ aktuell" to false
        (d.updateReady ?: 0) >= release.versionCode ->
            "$base · ⬇️ Update ${release.versionName} bereit – am Gerät „Jetzt aktualisieren“ tippen" to true
        rolledOut -> "$base · ⏳ lädt Update ${release.versionName} …" to false
        else -> "$base · Update ${release.versionName} verfügbar" to false
    }
}
