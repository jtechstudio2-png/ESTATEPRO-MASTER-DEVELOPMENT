'use client';

import { useFormat } from '@/lib/hooks/format';

/**
 * A date or time (UI checklist §1): relative within 7 days with the absolute
 * value in the title and for screen readers; the time zone is named when it
 * differs from the member's.
 */
export function When({ iso, timeZone, dateOnly = false }: { iso: string; timeZone?: string; dateOnly?: boolean }) {
  const format = useFormat();
  const zone = timeZone ?? format.timeZone;
  if (dateOnly || iso.length === 10) {
    return (
      <time dateTime={iso} className="ep-num">
        {format.date(iso, zone)}
      </time>
    );
  }
  const { text, absolute } = format.relative(iso, zone);
  const zoneNote = zone !== format.timeZone ? ` (${zone})` : '';
  return (
    <time dateTime={iso} title={`${absolute}${zoneNote}`} className="ep-num">
      <span aria-hidden="true">{text}</span>
      <span className="ep-visually-hidden">{`${absolute}${zoneNote}`}</span>
    </time>
  );
}
