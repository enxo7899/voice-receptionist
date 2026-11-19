// Guardrails. Everything in this file is enforced by code on every turn,
// whether the words came from the rule-based demo or from an LLM.

import { luhn } from './nlu.js';
import { normalize, digitRuns } from './normalize.js';

export function allowedPrices(business) {
  const set = new Set();
  for (const s of Object.values(business.services)) if (s.price != null) set.add(s.price);
  for (const p of business.otherPrices || []) set.add(p.price);
  return set;
}

/** Every £ amount in a reply must come from the price list. Returns the amounts that do not. */
export function unlistedPrices(reply, business) {
  const allowed = allowedPrices(business);
  const found = [...String(reply).matchAll(/£\s?(\d+(?:\.\d{2})?)/g)].map((m) => Number(m[1]));
  // Spoken prices too: "eighty five pounds"
  const spoken = [...String(reply).matchAll(/\b(\d+)\s*(pounds|quid)\b/gi)].map((m) => Number(m[1]));
  return [...found, ...spoken].filter((p) => !allowed.has(p));
}

export const PRICE_FALLBACK = "I can't give a price for that over the phone. One of our engineers can look at it and give you a written quote before any work starts.";

/** Replace any reply that names an unlisted price. */
export function guardReply(reply, business) {
  const bad = unlistedPrices(reply, business);
  if (!bad.length) return { reply, blocked: null };
  // Swap only the sentences that name an unlisted price, so the rest of the reply (the question) survives.
  const sentences = String(reply).match(/[^.?!]+[.?!]*\s*/g) || [reply];
  let swapped = false;
  const kept = [];
  for (const sentence of sentences) {
    if (unlistedPrices(sentence, business).length) {
      if (!swapped) kept.push(PRICE_FALLBACK + ' ');
      swapped = true;
    } else kept.push(sentence);
  }
  let out = kept.join('').trim();
  if (unlistedPrices(out, business).length) out = PRICE_FALLBACK;
  return { reply: out, blocked: { rule: 'unlisted_price', amounts: bad, original: reply } };
}

/** Remove card numbers before anything is logged, stored or shown to the owner. */
export function redactCards(text) {
  let out = String(text);
  // Digits possibly separated by spaces or dashes, 13 to 19 long, Luhn-valid.
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 13 && d.length <= 19 && luhn(d) && !d.startsWith('0') ? '[card number removed]' : m;
  });
  // Spoken digits ("four five three nine ...") are removed by checking the normalised form.
  const norm = normalize(out);
  for (const r of digitRuns(norm)) {
    if (r.length >= 13 && r.length <= 19 && luhn(r) && !r.startsWith('0')) return '[card number removed]';
  }
  out = out.replace(/\b(cvv|cvc|security code)\b[^.]*?\b\d{3,4}\b/gi, '$1 [removed]');
  return out;
}

export function inServiceArea(postcode, business) {
  return !!postcode && business.serviceArea.includes(postcode.toUpperCase());
}

export const SAFETY = {
  gas: (b) =>
    `Please treat this as an emergency. Don't use light switches, flames or anything electrical. Open doors and windows, turn off the gas at the meter if you can do it safely, and leave the property. Then call the National Gas Emergency Service on ${b.gasEmergencyNumber}; they are free and open 24 hours. We can't send an engineer to a gas leak before they have made it safe. I've told the office so someone can follow up with you.`,
  co: (b) =>
    `Please get everyone out into fresh air now, leave the door open behind you, and don't go back in. If anyone feels dizzy, sick or has a headache, call 999. Then call the National Gas Emergency Service on ${b.gasEmergencyNumber}. Don't use the appliance again until an engineer has checked it. I've told the office so someone can follow up with you.`,
  flood: (b) =>
    `Turn off your stop tap now if you can; it's usually under the kitchen sink. If water is near sockets or lights, switch the electrics off at the fuse box and keep away. I'm putting you through to our on-call engineer, ${b.onCall.name}, right now.`,
  card: () =>
    `For your security please don't read out card details. We never take payment over the phone; the engineer gives you an invoice after the job.`,
};

/**
 * The checks a booking must pass. Used by the demo agent and by the webhook
 * server, so an LLM-driven call cannot skip them either.
 */
export function bookingBlockers(job, business, { emergency = null } = {}) {
  const reasons = [];
  if (emergency === 'gas_emergency' || emergency === 'co_emergency') reasons.push('gas_or_co_emergency');
  if (!job.service || !business.services[job.service]) reasons.push('unknown_service');
  if (!inServiceArea(job.postcode, business)) reasons.push('outside_service_area');
  if (!job.name) reasons.push('missing_name');
  if (!job.phone || !/^0\d{9,10}$/.test(job.phone)) reasons.push('missing_phone');
  if (!job.phoneConfirmed) reasons.push('phone_not_read_back');
  return reasons;
}

export function formatPhone(p) {
  if (!p) return '';
  if (p.startsWith('07') && p.length === 11) return `${p.slice(0, 5)} ${p.slice(5)}`;
  if (p.startsWith('01') && p.length === 11) return `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}`;
  return p;
}

/** Read a number back digit by digit, the way a receptionist would. */
export function readBack(p) {
  return formatPhone(p).split(' ').map((g) => g.split('').join(' ')).join(', ');
}
