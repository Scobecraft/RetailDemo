package de.retaildemo.admin

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import de.retaildemo.core.MediaItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaScreen(vm: AdminViewModel, modifier: Modifier) {
    val media by vm.media.collectAsState()
    val uploads by vm.uploads.collectAsState()
    val settings by vm.settings.collectAsState()
    var editing by remember { mutableStateOf<MediaItem?>(null) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isNotEmpty()) vm.upload(uris)
    }

    Box(modifier.fillMaxSize()) {
        Column {
            TopAppBar(
                title = { Text("Medien") },
                actions = { IconButton(onClick = { vm.refreshAll() }) { Icon(Icons.Filled.Refresh, "Neu laden") } },
            )
            LazyVerticalGrid(
                columns = GridCells.Adaptive(150.dp),
                contentPadding = PaddingValues(12.dp, 0.dp, 12.dp, 96.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(uploads, key = { "u${it.key}" }, span = { GridItemSpan(maxLineSpan) }) { up ->
                    Card {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(up.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (up.error != null) {
                                    Text("Fehler: ${up.error}", color = MaterialTheme.colorScheme.error)
                                } else {
                                    LinearProgressIndicator(
                                        progress = { up.progress },
                                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                                    )
                                }
                            }
                            if (up.error != null) IconButton(onClick = { vm.dismissUpload(up.key) }) {
                                Icon(Icons.Filled.Close, "Schließen")
                            }
                        }
                    }
                }
                if (media.isEmpty() && uploads.isEmpty()) {
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        Text(
                            "Noch keine Medien. Tippe auf „Hinzufügen“, um Videos und Bilder hochzuladen.",
                            Modifier.padding(24.dp),
                        )
                    }
                }
                items(media, key = { it.id }) { item ->
                    MediaTile(vm, item, settings.imageDurationS) { editing = item }
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = {
                picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
            },
            icon = { Icon(Icons.Filled.Add, null) },
            text = { Text("Hinzufügen") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }

    editing?.let { item ->
        MediaEditDialog(
            item = item,
            defaultDuration = settings.imageDurationS,
            onDismiss = { editing = null },
            onSave = { title, dur -> vm.updateMedia(item.id, title, dur); editing = null },
            onDelete = { vm.deleteMedia(item.id); editing = null },
        )
    }
}

@Composable
private fun MediaTile(vm: AdminViewModel, item: MediaItem, defaultDuration: Int, onClick: () -> Unit) {
    Column(Modifier.clickable(onClick = onClick)) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF1F2937)),
        ) {
            AsyncImage(
                model = vm.api.thumbUrl(item.id),
                imageLoader = vm.imageLoader,
                contentDescription = item.title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            if (item.isVideo) Icon(
                Icons.Filled.PlayArrow, null,
                tint = Color.White,
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(40.dp)
                    .background(Color(0x88000000), RoundedCornerShape(20.dp)),
            )
        }
        Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
        Text(
            buildString {
                append(if (item.isVideo) "Video" else "Bild · ${item.durationS ?: defaultDuration} s")
                append(" · ")
                append(formatSize(item.size))
            },
            style = MaterialTheme.typography.bodySmall,
            color = Color.Gray,
        )
    }
}

@Composable
private fun MediaEditDialog(
    item: MediaItem,
    defaultDuration: Int,
    onDismiss: () -> Unit,
    onSave: (String, Int?) -> Unit,
    onDelete: () -> Unit,
) {
    var title by remember { mutableStateOf(item.title) }
    var duration by remember { mutableStateOf((item.durationS ?: defaultDuration).toString()) }
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Löschen?") },
            text = { Text("„${item.title}“ wird vom Server und beim nächsten Abgleich von allen Geräten gelöscht.") },
            confirmButton = { TextButton(onClick = onDelete) { Text("Löschen", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Abbrechen") } },
        )
        return
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (item.isVideo) "Video bearbeiten" else "Bild bearbeiten") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(title, { title = it }, label = { Text("Titel") }, singleLine = true)
                if (!item.isVideo) OutlinedTextField(
                    duration, { duration = it.filter(Char::isDigit) },
                    label = { Text("Anzeigedauer (Sekunden)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Row {
                    TextButton(onClick = { confirmDelete = true }) {
                        Text("Löschen", color = MaterialTheme.colorScheme.error)
                    }
                    Spacer(Modifier.width(1.dp))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(title, if (item.isVideo) null else duration.toIntOrNull())
            }) { Text("Speichern") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

fun formatSize(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1e9)
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1e6)
    else -> "${bytes / 1000} KB"
}
