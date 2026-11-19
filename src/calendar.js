// Engineer diary: half-day slots per engineer. Booking is checked here, in code,
// so two callers (or a confused AI) can never be given the same slot.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayName(iso) {
  return DAY_NAMES[new Date(iso + 'T12:00:00Z').getUTCDay()];
}
export function prettyDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  const month = d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const name = dayName(iso);
  return `${name[0].toUpperCase()}${name.slice(1)} ${d.getUTCDate()} ${month}`;
}

export function createCalendar(business) {
  const booked = new Map();
  for (const key of business.booked || []) booked.set(key, { id: key, existing: true });
  return { business, booked };
}

export function workingDays(cal, count = 10) {
  const days = [];
  let d = cal.business.today;
  while (days.length < count) {
    const n = dayName(d);
    if (n !== 'saturday' && n !== 'sunday') days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

export function slotKey(date, engineer, part) {
  return `${date}:${engineer}:${part}`;
}

export function isFree(cal, key) {
  return !cal.booked.has(key);
}

function slotIsPast(cal, date, part) {
  if (date !== cal.business.today) return false;
  const [h] = cal.business.nowTime.split(':').map(Number);
  if (part === 'am') return true; // morning slots for today are gone once the office is open
  return h >= 15; // no same-day afternoon bookings after 3pm
}

/** Resolve "monday", "tomorrow", "next week" to the first date to search from. */
export function resolveDay(cal, day) {
  const today = cal.business.today;
  if (!day || day === 'asap' || day === 'today') return { from: today, exact: day === 'today' };
  if (day === 'tomorrow') return { from: addDays(today, 1), exact: true };
  if (day === 'next week') {
    let d = addDays(today, 1);
    while (dayName(d) !== 'monday') d = addDays(d, 1);
    return { from: d, exact: false };
  }
  let d = today;
  for (let i = 0; i < 7; i++) {
    if (dayName(d) === day) return { from: d, exact: true };
    d = addDays(d, 1);
  }
  return { from: today, exact: false };
}

/**
 * Free slots, earliest first, honouring the caller's preference when it can.
 * `skip` holds slot keys the caller already turned down.
 */
export function findSlots(cal, { day, part, skip = [] } = {}, limit = 3) {
  const { from, exact } = resolveDay(cal, day);
  const out = [];
  const tryAdd = (date, p) => {
    for (const e of cal.business.engineers) {
      const key = slotKey(date, e.id, p);
      if (isFree(cal, key) && !skip.includes(key) && !slotIsPast(cal, date, p)) {
        out.push({ key, date, part: p, engineer: e.name });
        return true;
      }
    }
    return false;
  };
  const days = workingDays(cal, 12).filter((d) => d >= from);
  const parts = part ? [part, part === 'am' ? 'pm' : 'am'] : ['am', 'pm'];
  // First pass: exactly what they asked for.
  for (const date of days) {
    if (out.length >= limit) break;
    if (exact && date !== from) break;
    if (part) tryAdd(date, part);
    else for (const p of parts) if (out.length < limit) tryAdd(date, p);
  }
  // Second pass: the other half of the day, then any later day.
  for (const date of days) {
    for (const p of parts) {
      if (out.length >= limit) return out;
      if (out.some((s) => s.date === date && s.part === p)) continue;
      tryAdd(date, p);
    }
  }
  return out;
}

export function describeSlot(cal, slot) {
  return `${prettyDate(slot.date)}, ${slot.part === 'am' ? 'morning' : 'afternoon'} (${cal.business.slots[slot.part]})`;
}

/** The only way a job enters the diary. Rejects a taken slot instead of overwriting it. */
export function book(cal, key, job) {
  if (!isFree(cal, key)) return { ok: false, reason: 'slot_taken' };
  const [date, engineer, part] = key.split(':');
  const known = cal.business.engineers.find((e) => e.id === engineer);
  if (!known || !['am', 'pm'].includes(part)) return { ok: false, reason: 'unknown_slot' };
  const entry = { id: `JOB-${String(cal.booked.size + 1001)}`, key, date, part, engineer: known.name, ...job };
  cal.booked.set(key, entry);
  return { ok: true, job: entry };
}
