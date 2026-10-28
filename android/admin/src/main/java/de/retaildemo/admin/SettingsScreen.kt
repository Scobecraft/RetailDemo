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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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

            if (vm.isConfigured) ServerSettingsCard(settings) { vm.saveSettings(it) }
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

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Demo-Verhalten (alle Geräte)", style = MaterialTheme.typography.titleMedium)
            NumberField("Abgleich mit Server alle … Minuten", sync) { sync = it }
            NumberField("Demo startet wieder nach … Sekunden ohne Bedienung", idle) { idle = it }
            NumberField("Gerätedaten nach jedem … Medium zeigen", every) { every = it }
            NumberField("Gerätedaten-Anzeige dauert … Sekunden", specsDur) { specsDur = it }
            NumberField("Bilder werden standardmäßig … Sekunden gezeigt", imgDur) { imgDur = it }
            Button(onClick = {
                onSave(
                    ServerSettings(
                        syncIntervalMin = sync.toIntOrNull() ?: current.syncIntervalMin,
                        idleTimeoutS = idle.toIntOrNull() ?: current.idleTimeoutS,
                        specsEveryN = every.toIntOrNull() ?: current.specsEveryN,
                        specsDurationS = specsDur.toIntOrNull() ?: current.specsDurationS,
                        imageDurationS = imgDur.toIntOrNull() ?: current.imageDurationS,
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
