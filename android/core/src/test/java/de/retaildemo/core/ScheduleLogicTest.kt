package de.retaildemo.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

class ScheduleLogicTest {
    // 2026-11-02 ist ein Montag
    private fun at(day: Int, h: Int, m: Int = 0) = LocalDateTime.of(2026, 11, 2 + day, h, m)

    private val weekdays = Schedule(
        enabled = true,
        days = List(7) { DaySchedule(active = it < 6, on = "09:00", off = "20:00") },
    )

    @Test fun disabledIsAlwaysActive() {
        assertTrue(Schedule(enabled = false).isActiveAt(at(6, 3)))
        assertNull(Schedule(enabled = false).nextChange(at(0, 3)))
    }

    @Test fun normalDay() {
        assertFalse(weekdays.isActiveAt(at(0, 8, 59)))
        assertTrue(weekdays.isActiveAt(at(0, 9, 0)))
        assertTrue(weekdays.isActiveAt(at(0, 19, 59)))
        assertFalse(weekdays.isActiveAt(at(0, 20, 0)))
        assertFalse(weekdays.isActiveAt(at(6, 12))) // Sonntag aus
    }

    @Test fun nextChangeSkipsSunday() {
        assertEquals(at(0, 20), weekdays.nextChange(at(0, 10)))
        assertEquals(at(1, 9), weekdays.nextChange(at(0, 21)))
        // Samstag 20:00 -> nächster Start Montag 09:00
        assertEquals(LocalDateTime.of(2026, 11, 9, 9, 0), weekdays.nextChange(at(5, 20, 30)))
    }

    @Test fun overnight() {
        val night = Schedule(enabled = true, days = List(7) { DaySchedule(true, "22:00", "02:00") })
        assertTrue(night.isActiveAt(at(1, 23)))
        assertTrue(night.isActiveAt(at(1, 1)))
        assertFalse(night.isActiveAt(at(1, 3)))
        assertEquals(at(1, 2), night.nextChange(at(0, 23)).let { it })
    }

    @Test fun shortTimeFormat() {
        val s = Schedule(enabled = true, days = List(7) { DaySchedule(true, "8:30", "18:00") })
        assertTrue(s.isActiveAt(at(2, 8, 30)))
    }
}
