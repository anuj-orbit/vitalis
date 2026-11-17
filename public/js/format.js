// Pure formatting helpers. No DOM access at import time.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
}

const DUBAI = 'Asia/Dubai';

export function formatDubai(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: DUBAI,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${s} GST`;
}

export function formatDubaiTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DUBAI,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

export function aed(credits, priceAed = 5) {
  const n = Number(credits) * Number(priceAed);
  return `${Number.isFinite(n) ? n : 0} AED`;
}

const KINDS = { yoga: 'Yoga trainer', fitness: 'Fitness trainer', doctor: 'Doctor' };

export function kindLabel(kind) {
  return KINDS[kind] || 'Provider';
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "HH:00" in UTC -> "HH:00" Dubai (UTC+4); "24:00" -> "04:00". Adds "(+1)" when it rolls to the next day.
export function utcTimeToDubai(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  const total = h * 60 + m + 240;
  const day = total >= 1440 ? ' (+1)' : '';
  const t = total % 1440;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}${day}`;
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export const DISCLAIMER = 'Not for emergencies. In an emergency call 999 (UAE).';
