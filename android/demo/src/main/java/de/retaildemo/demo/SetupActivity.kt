package de.retaildemo.demo

import android.app.AlarmManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.launch
import de.retaildemo.core.shortLabel
import java.text.DateFormat
import java.util.Date

/** Einrichtung des Demo-Geräts (erreichbar über 3 s oben links drücken + PIN). */
class SetupActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    SetupScreen(
                        app = demoApp,
                        onStartDemo = {
                            startActivity(Intent(this, DemoActivity::class.java))
                            finish()
                        },
                    )
                }
            }
        }
    }
}

private fun Context.accessibilityEnabled(): Boolean {
    val me = ComponentName(this, IdleWatcherService::class.java).flattenToString()
    val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
    return enabled.split(':').any { it.equals(me, ignoreCase = true) }
}

private fun Context.batteryUnrestricted() =
    getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

@Composable
private fun SetupScreen(app: DemoApp, onStartDemo: () -> Unit) {
    val ctx = app
    val scope = rememberCoroutineScope()
    val prefs = app.prefs
    var url by remember { mutableStateOf(prefs.serverUrl) }
    var token by remember { mutableStateOf(prefs.deviceToken) }
    var pin by remember { mutableStateOf(prefs.pin) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val syncState by app.sync.state.collectAsState()
    val manifest by app.sync.manifest.collectAsState()

    // Berechtigungs-Status beim Zurückkehren aus den Systemeinstellungen neu prüfen
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refresh++ }
    val a11y = remember(refresh) { ctx.accessibilityEnabled() }
    val overlay = remember(refresh) { Settings.canDrawOverlays(ctx) }
    val battery = remember(refresh) { ctx.batteryUnrestricted() }
    val exactAlarms = remember(refresh) {
        android.os.Build.VERSION.SDK_INT < 31 || ctx.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    }
    var blockSettings by remember { mutableStateOf(prefs.blockSettings) }
    var blockAlarms by remember { mutableStateOf(prefs.blockAlarms) }
    var maxBrightness by remember { mutableStateOf(prefs.maxBrightness) }
    val writeSettings = remember(refresh) { Brightness.canWrite(ctx) }
    val storage = remember(refresh) { app.cleanup.hasStorageAccess() }
    val storagePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh++ }
    val cleanupState by app.cleanup.state.collectAsState()
    var confirmCleanup by remember { mutableStateOf(false) }
    val scheduleActive by app.schedule.active.collectAsState()

    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Demo einrichten", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)

        Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("1. Server", style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = url, onValueChange = { url = it },
                    label = { Text("Server-Adresse") },
                    placeholder = { Text("https://demo.meinedomain.de") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedTextField(
                    value = token, onValueChange = { token = it },
                    label = { Text("Geräte-Token (DEVICE_TOKEN)") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = pin, onValueChange = { pin = it.filter(Char::isDigit) },
                    label = { Text("Admin-PIN für dieses Gerät") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                )
                Button(
                    enabled = !busy && url.isNotBlank() && token.isNotBlank() && pin.length >= 4,
                    onClick = {
                        prefs.serverUrl = url
                        prefs.deviceToken = token
                        prefs.pin = pin
                        url = prefs.serverUrl
                        busy = true
                        message = null
                        scope.launch {
                            val err = app.sync.syncNow()
                            message = err?.let { "❌ $it" } ?: "✅ Verbunden und synchronisiert"
                            busy = false
                        }
                    },
                ) { Text(if (busy) "Verbinde …" else "Speichern & synchronisieren") }
                if (pin.length < 4) Text("PIN muss mindestens 4 Ziffern haben", color = MaterialTheme.colorScheme.error)
                message?.let { Text(it) }
                if (busy) Text(syncState, color = Color.Gray)
            }
        }

        Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("2. Berechtigungen", style = MaterialTheme.typography.titleMedium)
                PermissionRow(
                    ok = a11y,
                    title = "Rückkehr zur Demo nach Inaktivität",
                    hint = "Einstellungen → Bedienungshilfen → Installierte Apps → \"${ctx.getString(R.string.accessibility_label)}\" einschalten. " +
                        "Ist der Schalter gesperrt: App-Info → ⋮ (oben rechts) → \"Eingeschränkte Einstellungen zulassen\".",
                    button = "Öffnen",
                ) { ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                PermissionRow(
                    ok = overlay,
                    title = "Autostart nach Neustart",
                    hint = "\"Über anderen Apps einblenden\" erlauben.",
                    button = "Erlauben",
                ) {
                    ctx.startActivity(
                        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
                PermissionRow(
                    ok = battery,
                    title = "Im Hintergrund aktiv bleiben",
                    hint = "Akku-Optimierung für die Demo-App abschalten.",
                    button = "Erlauben",
                ) {
                    @Suppress("BatteryLife")
                    ctx.startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
                PermissionRow(
                    ok = storage,
                    title = "Kundenfotos löschen",
                    hint = "\"Zugriff auf alle Dateien\" erlauben.",
                    button = "Erlauben",
                ) {
                    if (android.os.Build.VERSION.SDK_INT >= 30) ctx.startActivity(
                        Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    ) else storagePermission.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                }
                PermissionRow(
                    ok = writeSettings,
                    title = "Helligkeit steuern",
                    hint = "\"Systemeinstellungen ändern\" erlauben (für Helligkeit 100 %).",
                    button = "Erlauben",
                ) {
                    ctx.startActivity(
                        Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
                PermissionRow(
                    ok = exactAlarms,
                    title = "Pünktliches Ein-/Ausschalten",
                    hint = "\"Wecker und Erinnerungen\" erlauben (für die Betriebszeiten).",
                    button = "Erlauben",
                ) {
                    if (android.os.Build.VERSION.SDK_INT >= 31) ctx.startActivity(
                        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
                Text(
                    "Tipp: Displaysperre auf \"Keine\" stellen und das Bildschirm-Timeout auf das Maximum setzen.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("3. Schutz für Vorführgeräte", style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Sprache & Passwort sperren", fontWeight = FontWeight.Medium)
                        Text(
                            "Kunden können Sprache, Displaysperre, PIN und Passwort nicht ändern. " +
                                "Zum Selbst-Ändern hier vorübergehend ausschalten.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Switch(checked = blockSettings, onCheckedChange = { blockSettings = it; prefs.blockSettings = it })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Wecker sperren", fontWeight = FontWeight.Medium)
                        Text(
                            "Die Uhr-App (Wecker, Timer, Stoppuhr) lässt sich nicht öffnen. " +
                                "Klingelt trotzdem ein Wecker, wird er automatisch beendet.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Switch(checked = blockAlarms, onCheckedChange = { blockAlarms = it; prefs.blockAlarms = it })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Helligkeit immer 100 %", fontWeight = FontWeight.Medium)
                        Text(
                            "Bei jedem Start der Demo wird die Helligkeit auf 100 % gestellt (automatische Helligkeit aus).",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Switch(checked = maxBrightness, onCheckedChange = {
                        maxBrightness = it; prefs.maxBrightness = it
                        if (it) Brightness.setMax(ctx)
                    })
                }
                val interval = manifest?.cleanupIntervalH ?: 2
                Text(
                    if (interval > 0) "Alle $interval Std. werden Fotos/Videos/Screenshots gelöscht und das Hintergrundbild zurückgesetzt."
                    else "Automatisches Aufräumen ist in der Admin-App ausgeschaltet.",
                    style = MaterialTheme.typography.bodySmall,
                )
                prefs.lastCleanup.takeIf { it > 0 }?.let {
                    StatusLine("Zuletzt aufgeräumt", DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)))
                }
                if (cleanupState.isNotBlank()) Text(cleanupState, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { confirmCleanup = true }) { Text("Jetzt aufräumen") }
                    OutlinedButton(onClick = { UninstallPinActivity.startUninstall(ctx) }) { Text("App deinstallieren") }
                }
                if (blockSettings && !a11y) Text(
                    "⚠️ Funktioniert nur mit eingeschalteter Bedienungshilfe (siehe oben).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("4. Status", style = MaterialTheme.typography.titleMedium)
                val last = prefs.lastSync.takeIf { it > 0 }
                    ?.let { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)) }
                StatusLine("Gerät", "${DeviceInfo.manufacturer()} ${DeviceInfo.marketingName(ctx)}")
                StatusLine("Geräte-ID", prefs.deviceId.take(8))
                StatusLine("Angezeigter Name", manifest?.displayName ?: "–")
                StatusLine("Playlist", manifest?.playlistName ?: "–")
                StatusLine(
                    "Inhalte",
                    manifest?.let { m -> "${m.items.count(app.sync::isAvailable)} von ${m.items.size} geladen" } ?: "–",
                )
                StatusLine("Letzter Abgleich", last ?: "noch nie")
                StatusLine("Abgleich alle", "${manifest?.syncIntervalMin ?: 60} Minuten")
                StatusLine(
                    "Betriebszeiten",
                    when {
                        manifest?.schedule?.enabled != true -> "immer an"
                        else -> (if (scheduleActive) "an" else "Ruhezeit") +
                            (app.schedule.nextChange?.let { " · ${if (scheduleActive) "aus" else "an"} ${it.shortLabel()}" } ?: "")
                    },
                )
                prefs.lastError?.let { StatusLine("Fehler", it) }
                OutlinedButton(
                    enabled = !busy && prefs.isConfigured,
                    onClick = {
                        busy = true
                        scope.launch {
                            val err = app.sync.syncNow()
                            message = err?.let { "❌ $it" } ?: "✅ Synchronisiert"
                            busy = false
                        }
                    },
                ) { Text("Jetzt synchronisieren") }
            }
        }

        if (confirmCleanup) AlertDialog(
            onDismissRequest = { confirmCleanup = false },
            title = { Text("Jetzt aufräumen?") },
            text = { Text("Alle Fotos, Videos und Screenshots auf diesem Gerät werden gelöscht und das Hintergrundbild zurückgesetzt.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmCleanup = false
                    scope.launch { message = app.cleanup.runNow() }
                }) { Text("Aufräumen", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmCleanup = false }) { Text("Abbrechen") } },
        )

        Button(
            onClick = onStartDemo,
            enabled = prefs.isConfigured && !busy,
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) { Text("Demo starten") }
        Text(
            "Zurück in diese Einstellungen: In der laufenden Demo mit 3 Fingern oben rechts 3 Sekunden gedrückt halten.",
            style = MaterialTheme.typography.bodySmall,
            color = Color.Gray,
        )
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun PermissionRow(ok: Boolean, title: String, hint: String, button: String, onClick: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(if (ok) "✅" else "⚠️")
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium)
            if (!ok) Text(hint, style = MaterialTheme.typography.bodySmall)
        }
        if (!ok) {
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = onClick) { Text(button) }
        }
    }
}

@Composable
private fun StatusLine(label: String, value: String) {
    Row {
        Text(label, Modifier.width(140.dp), color = Color.Gray)
        Text(value)
    }
}
