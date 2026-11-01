/**
 * Wall-clock times in a named time zone (K-3: due-back times are entered and
 * shown in the property's time zone and sent as ISO instants).
 */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** "2026-10-28T17:00" in `timeZone` → ISO instant. Null for an invalid value. */
export function zonedToInstant(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset around daylight-saving changes.
  let instant = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  instant = guess - offsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant).toISOString();
}

/** ISO instant → "2026-10-28T17:00" wall-clock time in `timeZone`. */
export function instantToZoned(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  const local = new Date(instant.getTime() + offsetMinutes(instant, timeZone) * 60_000);
  return local.toISOString().slice(0, 16);
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  return instantToZoned(now.toISOString(), timeZone).slice(0, 10);
}
