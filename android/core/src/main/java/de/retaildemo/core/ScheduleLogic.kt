package de.retaildemo.core

import java.time.DayOfWeek
import java.time.LocalDateTime
import java.time.LocalTime

private fun parseTime(t: String): LocalTime =
    runCatching { LocalTime.parse(t.padStart(5, '0')) }.getOrDefault(LocalTime.MIDNIGHT)

private fun Schedule.day(d: DayOfWeek) = days.getOrNull(d.value - 1) ?: DaySchedule()

/**
 * Ist die Demo zum Zeitpunkt [now] eingeschaltet?
 * Liegt "aus" vor "an" (z. B. 22:00–02:00), läuft die Demo über Mitternacht.
 */
fun Schedule.isActiveAt(now: LocalDateTime): Boolean {
    if (!enabled) return true
    val t = now.toLocalTime()
    val today = day(now.dayOfWeek)
    val yesterday = day(now.dayOfWeek.minus(1))
    val on = parseTime(today.on)
    val off = parseTime(today.off)
    val inToday = today.active && if (on < off) t >= on && t < off else t >= on
    // Über Mitternacht laufender Zeitraum vom Vortag
    val yOn = parseTime(yesterday.on)
    val yOff = parseTime(yesterday.off)
    val fromYesterday = yesterday.active && yOn >= yOff && t < yOff
    return inToday || fromYesterday
}

/** Nächster Zeitpunkt nach [now], an dem die Demo an- oder ausgeht (null = nie). */
fun Schedule.nextChange(now: LocalDateTime): LocalDateTime? {
    if (!enabled) return null
    val candidates = (0..8).flatMap { offset ->
        val date = now.toLocalDate().plusDays(offset.toLong())
        val d = day(date.dayOfWeek)
        if (!d.active) emptyList()
        else listOf(date.atTime(parseTime(d.on)), date.atTime(parseTime(d.off)))
    }.filter { it.isAfter(now) }.sorted()
    val current = isActiveAt(now)
    return candidates.firstOrNull { isActiveAt(it) != current }
}

/** Lesbarer Text wie "Mo 09:00", für Statusanzeigen. */
fun LocalDateTime.shortLabel(): String {
    val names = listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")
    return "${names[dayOfWeek.value - 1]} %02d:%02d".format(hour, minute)
}
