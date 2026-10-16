const taipeiDateTimeFormat = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatTaipeiDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Map(taipeiDateTimeFormat.formatToParts(date).map(part => [part.type, part.value]));
  const year = parts.get('year');
  const month = parts.get('month');
  const day = parts.get('day');
  const hour = parts.get('hour');
  const minute = parts.get('minute');
  if (!year || !month || !day || !hour || !minute) return '';
  return `${year}/${month}/${day} ${hour}:${minute}`;
}
