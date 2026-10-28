package de.retaildemo.admin

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import de.retaildemo.core.MediaItem
import de.retaildemo.core.Playlist
import de.retaildemo.core.PlaylistBody

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaylistsScreen(vm: AdminViewModel, modifier: Modifier) {
    val playlists by vm.playlists.collectAsState()
    val devices by vm.devices.collectAsState()
    var editingId by remember { mutableStateOf<Int?>(null) }
    var creating by remember { mutableStateOf(false) }

    val editing = playlists.firstOrNull { it.id == editingId }
    if (editing != null) {
        PlaylistEditor(vm, editing, modifier) { editingId = null }
        return
    }

    Box(modifier.fillMaxSize()) {
        Column {
            TopAppBar(title = { Text("Playlists") })
            LazyColumn(
                contentPadding = PaddingValues(12.dp, 0.dp, 12.dp, 96.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Text(
                        if (playlists.isEmpty())
                            "Ohne Playlist zeigen alle Geräte alle Medien. Lege Playlists an, um verschiedenen Geräten unterschiedliche Inhalte zu geben."
                        else
                            "Geräte ohne eigene Zuweisung zeigen die Standard-Playlist (★).",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color.Gray,
                    )
                }
                items(playlists, key = { it.id }) { pl ->
                    val count = devices.count { it.playlistId == pl.id || (it.playlistId == null && pl.isDefault) }
                    Card(Modifier.fillMaxWidth().clickable { editingId = pl.id }) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (pl.isDefault) Icon(
                                        Icons.Filled.Star, "Standard",
                                        tint = Color(0xFFF59E0B), modifier = Modifier.size(18.dp),
                                    )
                                    Text(pl.name, fontWeight = FontWeight.SemiBold)
                                }
                                Text(
                                    "${pl.mediaIds.size} Medien · $count Gerät(e)",
                                    style = MaterialTheme.typography.bodySmall, color = Color.Gray,
                                )
                            }
                        }
                    }
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { creating = true },
            icon = { Icon(Icons.Filled.Add, null) },
            text = { Text("Neue Playlist") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }

    if (creating) {
        var name by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { creating = false },
            title = { Text("Neue Playlist") },
            text = { OutlinedTextField(name, { name = it }, label = { Text("Name, z. B. Samsung") }, singleLine = true) },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = { vm.createPlaylist(name); creating = false }) {
                    Text("Anlegen")
                }
            },
            dismissButton = { TextButton(onClick = { creating = false }) { Text("Abbrechen") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlaylistEditor(vm: AdminViewModel, pl: Playlist, modifier: Modifier, onClose: () -> Unit) {
    val media by vm.media.collectAsState()
    val byId = media.associateBy { it.id }
    var name by remember(pl.id) { mutableStateOf(pl.name) }
    var isDefault by remember(pl.id) { mutableStateOf(pl.isDefault) }
    var showSpecs by remember(pl.id) { mutableStateOf(pl.showSpecs) }
    val ids = remember(pl.id) { mutableStateListOf<String>().apply { addAll(pl.mediaIds) } }
    var picking by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    BackHandler(onBack = onClose)

    Column(modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Playlist bearbeiten") },
            navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Zurück") } },
            actions = { IconButton(onClick = { confirmDelete = true }) { Icon(Icons.Filled.Delete, "Löschen") } },
        )
        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth())
            }
            item { SwitchRow("Standard-Playlist", "Für alle Geräte ohne eigene Zuweisung", isDefault) { isDefault = it } }
            item { SwitchRow("Gerätedaten anzeigen", "Zwischendurch Name & Specs des Geräts einblenden", showSpecs) { showSpecs = it } }
            item {
                Text("Reihenfolge (${ids.size})", style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 8.dp))
            }
            itemsIndexed(ids, key = { i, id -> "$i-$id" }) { i, id ->
                val m = byId[id]
                Card {
                    Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Thumb(vm, id)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(m?.title ?: "(gelöscht)", maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(if (m?.isVideo == true) "Video" else "Bild",
                                style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                        }
                        IconButton(enabled = i > 0, onClick = { ids.add(i - 1, ids.removeAt(i)) }) {
                            Icon(Icons.Filled.KeyboardArrowUp, "Nach oben")
                        }
                        IconButton(enabled = i < ids.lastIndex, onClick = { ids.add(i + 1, ids.removeAt(i)) }) {
                            Icon(Icons.Filled.KeyboardArrowDown, "Nach unten")
                        }
                        IconButton(onClick = { ids.removeAt(i) }) { Icon(Icons.Filled.Close, "Entfernen") }
                    }
                }
            }
            item {
                OutlinedButton(onClick = { picking = true }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Add, null); Spacer(Modifier.width(6.dp)); Text("Medien hinzufügen")
                }
            }
        }
        Button(
            onClick = {
                vm.savePlaylist(pl.id, PlaylistBody(name, ids.toList(), isDefault, showSpecs))
                onClose()
            },
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        ) { Text("Speichern") }
    }

    if (picking) MediaPicker(vm, media, alreadyIn = ids.toSet(), onDismiss = { picking = false }) { chosen ->
        ids.addAll(chosen)
        picking = false
    }
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("Playlist löschen?") },
        text = { Text("Geräte mit dieser Playlist zeigen danach die Standard-Playlist.") },
        confirmButton = {
            TextButton(onClick = { vm.deletePlaylist(pl.id); confirmDelete = false; onClose() }) {
                Text("Löschen", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Abbrechen") } },
    )
}

@Composable
private fun MediaPicker(
    vm: AdminViewModel,
    media: List<MediaItem>,
    alreadyIn: Set<String>,
    onDismiss: () -> Unit,
    onPick: (List<String>) -> Unit,
) {
    val selected = remember { mutableStateListOf<String>() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Medien auswählen") },
        text = {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(media, key = { it.id }) { m ->
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            if (m.id in selected) selected.remove(m.id) else selected.add(m.id)
                        }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(m.id in selected, onCheckedChange = null)
                        Spacer(Modifier.width(8.dp))
                        Thumb(vm, m.id)
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(m.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (m.id in alreadyIn) Text("schon enthalten", style = MaterialTheme.typography.bodySmall,
                                color = Color.Gray)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = selected.isNotEmpty(), onClick = { onPick(selected.toList()) }) {
                Text("Hinzufügen (${selected.size})")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

@Composable
private fun Thumb(vm: AdminViewModel, id: String) {
    AsyncImage(
        model = vm.api.thumbUrl(id),
        imageLoader = vm.imageLoader,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)),
    )
}

@Composable
fun SwitchRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Color.Gray)
        }
        Switch(checked, onChange)
    }
}
