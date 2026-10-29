// Betriebszeiten – gleiche Regeln wie in der Handy-Demo (core/ScheduleLogic.kt).
// days[0] = Montag … days[6] = Sonntag. Liegt "aus" vor "an", läuft die Demo über Mitternacht.

function minutes(t) {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function isActiveAt(schedule, date = new Date()) {
  if (!schedule || !schedule.enabled) return true;
  const days = schedule.days || [];
  const idx = (date.getDay() + 6) % 7; // JS: 0 = Sonntag
  const today = days[idx] || { active: true, on: "09:00", off: "20:00" };
  const yesterday = days[(idx + 6) % 7] || { active: true, on: "09:00", off: "20:00" };
  const t = date.getHours() * 60 + date.getMinutes();
  const on = minutes(today.on), off = minutes(today.off);
  const inToday = today.active && (on < off ? t >= on && t < off : t >= on);
  const yOn = minutes(yesterday.on), yOff = minutes(yesterday.off);
  const fromYesterday = yesterday.active && yOn >= yOff && t < yOff;
  return inToday || fromYesterday;
}

module.exports = { isActiveAt };
