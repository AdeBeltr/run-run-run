import { RULES } from './core.js';

const z = (n) => String(n).padStart(2, '0');
const utc = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}T${z(d.getUTCHours())}${z(d.getUTCMinutes())}00Z`;
};

export function makeICS(p, placeName) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Run run run//FR', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${p.id}@runrunrun`, `DTSTAMP:${utc(Date.now())}`,
    `DTSTART:${utc(p.start)}`, `DTEND:${utc(p.start + RULES.slotMs)}`,
    'SUMMARY:Run run run : sortie course', `LOCATION:${placeName || ''}`,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Ta sortie arrive !', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

export function downloadICS(p, placeName) {
  const blob = new Blob([makeICS(p, placeName)], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sortie-run.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
