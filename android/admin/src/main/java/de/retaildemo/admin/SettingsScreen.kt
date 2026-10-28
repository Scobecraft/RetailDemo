package de.retaildemo.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import android.app.TimePickerDialog
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import de.retaildemo.core.DaySchedule
import de.retaildemo.core.Schedule
import de.retaildemo.core.ServerSettings
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: AdminViewModel, modifier: Modifier) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(vm.serverUrl) }
    var token by remember { mutableStateOf(vm.adminToken) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    val settings by vm.settings.collectAsState()

    Column(modifier.fillMaxSize()) {
        TopAppBar(title = { Text("Einstellungen") })
        Column(
            Modifier.verticalScroll(rememberScrollState()).imePadding().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Server-Verbindung", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(
                        url, { url = it }, label = { Text("Server-Adresse") }, singleLine = true,
                        placeholder = { Text("https://demo.meinedomain.de") },
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    )
                    OutlinedTextField(
                        token, { token = it }, label = { Text("Admin-Token (ADMIN_TOKEN)") }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        enabled = !busy && url.isNotBlank() && token.isNotBlank(),
                        onClick = {
                            busy = true
                            scope.launch {
                                val err = vm.connect(url, token)
                                result = err?.let { "❌ $it" } ?: "✅ Verbunden"
                                if (err == null) url = vm.serverUrl
                                busy = false
                            }
                        },
                    ) { Text(if (busy) "Verbinde …" else "Verbinden") }
                    result?.let { Text(it) }
                }
            }

            if (vm.isConfigured) {
                ScheduleCard(settings) { vm.saveSettings(settings.copy(schedule = it)) }
                ServerSettingsCard(settings) { vm.saveSettings(it.copy(schedule = settings.schedule)) }
            }
        }
    }
}

@Composable
private fun ServerSettingsCard(current: ServerSettings, onSave: (ServerSettings) -> Unit) {
    var sync by remember(current) { mutableStateOf(current.syncIntervalMin.toString()) }
    var idle by remember(current) { mutableStateOf(current.idleTimeoutS.toString()) }
    var every by remember(current) { mutableStateOf(current.specsEveryN.toString()) }
    var specsDur by remember(current) { mutableStateOf(current.specsDurationS.toString()) }
    var imgDur by remember(current) { mutableStateOf(current.imageDurationS.toString()) }
    var cleanup by remember(current) { mutableStateOf(current.cleanupIntervalH.toString()) }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Demo-Verhalten (alle Geräte)", style = MaterialTheme.typography.titleMedium)
            NumberField("Abgleich mit Server alle … Minuten", sync) { sync = it }
            NumberField("Demo startet wieder nach … Sekunden ohne Bedienung", idle) { idle = it }
            NumberField("Gerätedaten nach jedem … Medium zeigen", every) { every = it }
            NumberField("Gerätedaten-Anzeige dauert … Sekunden", specsDur) { specsDur = it }
            NumberField("Bilder werden standardmäßig … Sekunden gezeigt", imgDur) { imgDur = it }
            NumberField("Kundenfotos löschen & Hintergrund zurücksetzen alle … Stunden (0 = aus)", cleanup) { cleanup = it }
            Button(onClick = {
                onSave(
                    ServerSettings(
                        syncIntervalMin = sync.toIntOrNull() ?: current.syncIntervalMin,
                        idleTimeoutS = idle.toIntOrNull() ?: current.idleTimeoutS,
                        specsEveryN = every.toIntOrNull() ?: current.specsEveryN,
                        specsDurationS = specsDur.toIntOrNull() ?: current.specsDurationS,
                        imageDurationS = imgDur.toIntOrNull() ?: current.imageDurationS,
                        cleanupIntervalH = cleanup.toIntOrNull() ?: current.cleanupIntervalH,
                    )
                )
            }) { Text("Speichern") }
            Text(
                "Änderungen kommen beim nächsten Abgleich auf den Geräten an. Unter „Geräte“ → „Alle aktualisieren“ geht es schneller.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun NumberField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value, { onChange(it.filter(Char::isDigit)) }, label = { Text(label) }, singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

private val WEEKDAYS = listOf("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")

@Composable
private fun ScheduleCard(current: ServerSettings, onSave: (Schedule) -> Unit) {
    var enabled by remember(current) { mutableStateOf(current.schedule.enabled) }
    val days = remember(current) { mutableStateListOf<DaySchedule>().apply { addAll(current.schedule.days) } }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Betriebszeiten (alle Geräte)", style = MaterialTheme.typography.titleMedium)
            SwitchRow(
                "Zeitsteuerung aktiv",
                "Außerhalb der Zeiten ist die Demo aus und das Display im Standby (schont den Akku).",
                enabled,
            ) { enabled = it }
            if (enabled) {
                days.forEachIndexed { i, d ->
                    HorizontalDivider()
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(d.active, onCheckedChange = { days[i] = d.copy(active = it) })
                        Text(WEEKDAYS[i], Modifier.weight(1f))
                        if (d.active) {
                            TimeButton(d.on) { days[i] = days[i].copy(on = it) }
                            Text("–")
                            TimeButton(d.off) { days[i] = days[i].copy(off = it) }
                        } else {
                            Text("aus", color = Color.Gray, modifier = Modifier.padding(end = 12.dp))
                        }
                    }
                }
                TextButton(onClick = {
                    val mo = days[0]
                    for (i in 1..4) days[i] = days[i].copy(on = mo.on, off = mo.off, active = mo.active)
                }) { Text("Montag für Di–Fr übernehmen") }
            }
            Button(onClick = { onSave(Schedule(enabled, days.toList())) }) { Text("Speichern") }
            Text(
                "Geräte übernehmen die Zeiten beim nächsten Abgleich (oder sofort über „Geräte“ → „Alle aktualisieren“).",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun TimeButton(value: String, onChange: (String) -> Unit) {
    val ctx = LocalContext.current
    OutlinedButton(
        onClick = {
            val (h, m) = value.split(":").map { it.toIntOrNull() ?: 0 }
            TimePickerDialog(ctx, { _, hh, mm -> onChange("%02d:%02d".format(hh, mm)) }, h, m, true).show()
        },
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp),
        modifier = Modifier.width(76.dp),
    ) { Text(value) }
}
