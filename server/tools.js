// The receptionist's rules as tools a voice platform's LLM can call.
// The LLM chooses what to say; these functions decide what is allowed to happen.

import { createCalendar, findSlots, describeSlot, book } from '../src/calendar.js';
import { normalize } from '../src/normalize.js';
import { classify, extractPostcode, extractPhone } from '../src/nlu.js';
import { SAFETY, inServiceArea, bookingBlockers, redactCards, formatPhone } from '../src/policy.js';

export function createTools(business, calendar = createCalendar(business)) {
  const emergencies = new Map(); // callId -> 'gas_emergency' | 'co_emergency' | 'flood'

  const tools = {
    /** Call on every caller turn before anything else. */
    triage({ caller_said = '' }, call) {
      const intent = classify(normalize(caller_said));
      if (['gas_emergency', 'co_emergency', 'flood'].includes(intent)) {
        emergencies.set(call.id, intent);
        const kind = intent === 'flood' ? 'flood' : intent === 'gas_emergency' ? 'gas' : 'co';
        return {
          emergency: intent,
          say_exactly: SAFETY[kind](business),
          next: intent === 'flood' ? `transfer the call to ${business.onCall.number}` : 'end the call after saying this; do not book anything',
        };
      }
      return { emergency: null };
    },

    get_price({ service }) {
      const s = business.services[service];
      if (!s) return { known: false, say: "I can't give a price for that over the phone; the office can call back with a quote.", services: Object.keys(business.services) };
      return { known: true, service, say: s.priceText };
    },

    check_service_area({ postcode }) {
      const district = extractPostcode(normalize(postcode || '')) || null;
      return { postcode: district, covered: inServiceArea(district, business), area: 'Leeds LS1 to LS17' };
    },

    /** Returns the number formatted for read-back. The LLM must read it back and get a yes. */
    read_back_phone({ phone }) {
      const p = extractPhone(normalize(phone || ''));
      return p ? { phone: p, read_back: formatPhone(p) } : { phone: null, error: 'not a valid UK number' };
    },

    find_slots({ day, part }) {
      return findSlots(calendar, { day, part }).map((s) => ({ slot_key: s.key, when: describeSlot(calendar, s), engineer: s.engineer }));
    },

    book_job({ slot_key, service, postcode, name, phone, phone_confirmed }, call) {
      const job = {
        service,
        postcode: extractPostcode(normalize(postcode || '')),
        name: name ? String(name).slice(0, 80) : null,
        phone: extractPhone(normalize(phone || '')),
        phoneConfirmed: phone_confirmed === true,
      };
      const blockers = bookingBlockers(job, business, { emergency: emergencies.get(call.id) });
      if (blockers.length) return { booked: false, blocked_by: blockers };
      const res = book(calendar, slot_key, { ...job, callId: call.id });
      if (!res.ok) return { booked: false, blocked_by: [res.reason], alternatives: tools.find_slots({}) };
      return { booked: true, job_id: res.job.id, when: describeSlot(calendar, res.job), engineer: res.job.engineer };
    },

    /** Free-text notes for the office. Card numbers are stripped before storing. */
    take_message({ name, phone, message }) {
      return { stored: true, message: redactCards(String(message || '')).slice(0, 1000), name, phone };
    },
  };
  return { tools, calendar };
}
