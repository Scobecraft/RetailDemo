package de.retaildemo.admin

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector

class AdminActivity : ComponentActivity() {
    private val vm: AdminViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val dark = isSystemInDarkTheme()
            MaterialTheme(
                colorScheme = if (dark) darkColorScheme(primary = Color(0xFF5EEAD4))
                else lightColorScheme(primary = Color(0xFF0F766E))
            ) { AdminRoot(vm) }
        }
    }
}

private enum class Tab(val label: String, val icon: ImageVector) {
    Overview("Übersicht", Icons.Filled.Home),
    Media("Medien", Icons.Filled.PlayArrow),
    Playlists("Playlists", Icons.Filled.List),
    Devices("Geräte", Icons.Filled.Phone),
    Settings("Einstellungen", Icons.Filled.Settings),
}

@Composable
private fun AdminRoot(vm: AdminViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(if (vm.isConfigured) 0 else Tab.Settings.ordinal) }
    val snackbar = remember { SnackbarHostState() }
    val message by vm.messages.collectAsState()
    LaunchedEffect(message) {
        message?.let {
            vm.messages.value = null
            snackbar.showSnackbar(it)
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t.ordinal,
                        onClick = { tab = t.ordinal },
                        icon = { Icon(t.icon, contentDescription = null) },
                        label = { Text(t.label, maxLines = 1, style = MaterialTheme.typography.labelSmall) },
                    )
                }
            }
        },
    ) { padding ->
        val mod = Modifier.padding(padding)
        when (Tab.entries[tab]) {
            Tab.Overview -> OverviewScreen(vm, mod)
            Tab.Media -> MediaScreen(vm, mod)
            Tab.Playlists -> PlaylistsScreen(vm, mod)
            Tab.Devices -> DevicesScreen(vm, mod)
            Tab.Settings -> SettingsScreen(vm, mod)
        }
    }
}
