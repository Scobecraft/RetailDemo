package de.retaildemo.demo

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation

/** Fragt die Admin-PIN ab, bevor die Demo-App deinstalliert werden darf. */
class UninstallPinActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = demoApp
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                var pin by remember { mutableStateOf("") }
                var wrong by remember { mutableStateOf(false) }
                // Bewusst kein separates Dialog-Fenster: alles im eigenen (durchsichtigen) Fenster
                Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Card {
                        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("Demo-App deinstallieren", style = MaterialTheme.typography.titleLarge)
                            Text("Zum Deinstallieren bitte die Admin-PIN eingeben.")
                            OutlinedTextField(
                                value = pin,
                                onValueChange = { pin = it.filter(Char::isDigit); wrong = false },
                                singleLine = true,
                                isError = wrong,
                                label = { Text(if (wrong) "Falsche PIN" else "PIN") },
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                            )
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                TextButton(onClick = { finish() }) { Text("Abbrechen") }
                                TextButton(onClick = {
                                    if (pin == app.prefs.pin) {
                                        startUninstall(this@UninstallPinActivity)
                                        finish()
                                    } else wrong = true
                                }) { Text("Deinstallieren") }
                            }
                        }
                    }
                }
            }
        }
    }

    companion object {
        /** Öffnet den echten System-Dialog zum Deinstallieren (Schutz für 2 Minuten aufgehoben). */
        fun startUninstall(context: Context) {
            val app = context.demoApp
            app.uninstallUnlockedUntil = SystemClock.elapsedRealtime() + 120_000
            app.scope.launch {
                // Erst beim Server abmelden, damit das Gerät aus der Admin-App verschwindet.
                // Wird das Deinstallieren abgebrochen, meldet sich das Gerät beim nächsten Kontakt wieder an.
                withTimeoutOrNull(5_000) { app.sync.unregister() }
                app.startActivity(
                    Intent(Intent.ACTION_DELETE, Uri.parse("package:${app.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }
}
