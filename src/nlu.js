// Reads one caller turn: what they want (intent) and the details they gave (slots).
// Deterministic rules, so the live demo needs no API key. The optional LLM path
// (server/) uses the same guardrails, because those live in policy.js, not here.

import { normalize, digitRuns } from './normalize.js';

const has = (t, re) => re.test(t);

export const EMERGENCY = {
  gas: /\b(smell(s|ing)? (of )?gas|gas (smell|leak|leaking)|smells? like gas|rotten eggs?|gas is leaking|leaking gas)\b/,
  co: /\b(carbon monoxide|monoxide|co (alarm|detector)|alarm for co)\b/,
  flood: /\b((leak(ing)?|water|drip(ping)?)\b.{0,25}\b(light|lights|socket|sockets|fuse ?box|electrics?|wiring)|burst (pipe|water)|pipe (has )?burst|pipes? (have |has )?burst|flood(ing|ed)?|water (is )?(pouring|gushing|everywhere|coming through)|through the ceiling|ceiling is (coming down|leaking badly))\b/,
};

const SERVICE_RULES = [
  ['gas_safety_certificate', /\b(gas safe(ty)? (cert|certificate|check|record)|cp12|landlord('s)? (gas )?(cert|certificate|check)|gas cert(ificate)?)\b/],
  ['new_boiler', /\b(new boiler|boiler (replacement|install(ation)?|upgrade)|replace (my |the |our |an? )?(old |existing )?boiler|install (a |my |the )?(new )?boiler|combi (swap|conversion))\b/],
  ['bathroom', /\b(bathroom (fit(ting)?|install|refit|renovation)|new bathroom|fit (a |my |the )?bathroom|shower room)\b/],
  ['boiler_service', /\b(serv(ice|iced|icing)\b.{0,20}\bboiler|boiler\b.{0,20}\bserv(ice|iced|icing)|annual serv(ice|icing)|boiler check ?up)\b/],
  ['blocked_drain', /\b(block(ed|age)|drain|won't drain|isn't draining|not draining|clogged|backing up)\b/],
  ['tap_replacement', /\b(taps?)\b/],
  ['radiator', /\bradiators?\b/],
  ['boiler_repair', /\b(no (heating|heat|hot water)|(boiler|heating|hot water|radiators?)\b.{0,30}\b(not working|isn't working|not work|stopped|won't|wont|isn't|broken|keeps|making|lost|losing|leaking|fault|error|pressure|cut(ting)? out|packed in|died|off|gone|playing up|not coming on|cold)|boiler fault|lost pressure|boiler (repair|problem|issue)|f\d\d? (code|error)|error code|pilot light)\b/],
  ['leak_repair', /\b(leak(s|ing|y)?|drip(ping|s)?|water (under|coming from|on the floor))\b/],
  ['boiler_repair', /\b(?<!(underfloor|install|new|solar|fit) )(boiler|heating)\b(?! (install|installation|system design))/],
];

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const YES = /^(yes|yeah|yep|yup|ya|aye|correct|that's (right|correct|it|fine|perfect|great)|thats (right|correct)|right|sure|ok(ay)?|perfect|great|lovely|sounds (good|great|fine)|please (do|book it)|go (ahead|for it)|book it|that works|that's fine|fine|spot on|absolutely|definitely)\b/;
const NO = /^(no|nope|nah|not (really|quite|right)|that's (not|wrong)|thats (not|wrong)|wrong|incorrect|that doesn't work|doesn't work|can't do)\b/;

const NAME_STOP = new Set(['calling', 'ringing', 'phoning', 'looking', 'just', 'having', 'after', 'trying', 'wondering', 'not', 'a', 'the', 'in', 'at', 'from', 'on', 'here', 'sorry', 'fine', 'good', 'okay', 'ok', 'yes', 'no', 'afraid', 'worried', 'the', 'landlord', 'tenant', 'renting', 'free', 'available', 'home', 'out', 'away', 'still', 'really', 'so', 'very', 'about', 'gonna', 'going', 'interested', 'phoning', 'actually', 'also', 'and', 'but', 'my', 'that', 'there', 'is', 'it', 'its', 'with']);
const NAME_PATTERNS = [
  /\bmy name(?:'s| is)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)/,
  /\bname(?:'s| is)?\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)/,
  /\b(?:this is|speaking)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\b/,
  /\bunder\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\b/,
];

function titleCase(s) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Luhn check, so a card number is recognised (and removed) even if the caller never says "card". */
export function luhn(d) {
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function findCardNumber(norm) {
  const runs = digitRuns(norm);
  for (const r of runs) if (r.length >= 13 && r.length <= 19 && luhn(r) && !/^0/.test(r)) return r;
  if (/\b(card number|long number on (the|my) card|cvv|cvc|security code|expiry date|sort code)\b/.test(norm)) return 'mentioned';
  return null;
}

// "it's ..." and "i'm ..." are only names when we have just asked for one ("it's overdue", "i'm in ls6").
const NAME_REPLY = /\b(?:it's|its|i'm|i am)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\b/;

export function extractName(norm, { expectingName = false } = {}) {
  for (const re of expectingName ? [...NAME_PATTERNS, NAME_REPLY] : NAME_PATTERNS) {
    const m = norm.match(re);
    if (!m) continue;
    const words = m[1].split(/\s+/).filter((w) => !NAME_STOP.has(w) && !/\d/.test(w));
    // Stop at the first stop word, so "i'm calling about" never becomes a name.
    const first = m[1].split(/\s+/)[0];
    if (NAME_STOP.has(first)) continue;
    const kept = [];
    for (const w of m[1].split(/\s+/)) { if (NAME_STOP.has(w) || /\d/.test(w)) break; kept.push(w); }
    if (kept.length && words.length) return titleCase(kept.join(' '));
  }
  if (expectingName) {
    // Answer to "can I take your name?": "sarah jones", "it's sarah", "sarah jones please"
    const cleaned = norm.replace(/\b(yes|yeah|sure|ok|okay|please|thanks|thank you|of course|it's|its|yep)\b/g, ' ').trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 3 && words.every((w) => /^[a-z][a-z'-]+$/.test(w) && !NAME_STOP.has(w))) {
      return titleCase(words.slice(0, 2).join(' '));
    }
  }
  return null;
}

export function extractPhone(norm) {
  // Postcodes and times are not phone numbers.
  const t = norm.replace(/\bls\d{1,2}(\s+\d[a-z]{2})?\b/g, ' ').replace(/\b\d{1,2}\s*(am|pm)\b/g, ' ');
  for (const r of digitRuns(t)) {
    if (/^0\d{9,10}$/.test(r)) return r;
    if (/^44\d{9,10}$/.test(r)) return '0' + r.slice(2);
  }
  return null;
}

/** Any digit run long enough to be meant as a phone number but not valid. */
export function looksLikeBadPhone(norm) {
  const t = norm.replace(/\bls\d{1,2}(\s+\d[a-z]{2})?\b/g, ' ');
  return digitRuns(t).some((r) => r.length >= 6 && !/^0\d{9,10}$/.test(r) && !(r.length >= 13 && luhn(r)));
}

export function extractPostcode(norm) {
  const m = norm.match(/\b([a-z]{1,2}\d{1,2}[a-z]?)(?:\s+\d[a-z]{2})?\b/g);
  if (!m) return null;
  for (const cand of m) {
    const out = cand.split(/\s+/)[0];
    if (/^(cp12|f\d+|e\d+)$/.test(out)) continue;
    if (/^[a-z]{1,2}\d{1,2}[a-z]?$/.test(out)) return out.toUpperCase();
  }
  return null;
}

export function extractService(norm) {
  for (const [id, re] of SERVICE_RULES) if (re.test(norm)) return id;
  return null;
}

/** Day and part of day: { day: 'monday' | 'today' | 'tomorrow' | 'asap' | 'next week', part: 'am' | 'pm' } */
export function extractWhen(norm) {
  const out = {};
  if (/\b(asap|as soon as (possible|you can)|soonest|earliest|first (available|slot|thing you('ve)? got)|whenever|any ?(day|time)|don't mind|doesn't matter|not fussy|whatever('s)? (first|soonest|earliest))\b/.test(norm)) out.day = 'asap';
  if (/\btoday\b|\bthis afternoon\b/.test(norm)) out.day = 'today';
  if (/\btomorrow\b/.test(norm)) out.day = 'tomorrow';
  if (/\bnext week\b/.test(norm)) out.day = 'next week';
  for (const d of DAYS) if (new RegExp(`\\b${d}s?\\b`).test(norm)) out.day = d;
  if (/\b(morning|am|first thing|before (12|noon|lunch))\b/.test(norm)) out.part = 'am';
  if (/\b(afternoon|pm|after (12|noon|lunch)|later in the day)\b/.test(norm)) out.part = 'pm';
  return out;
}

export function extractVulnerable(norm) {
  return /\b(my (nan|nana|gran|granny|grandma|grandad|grandpa|grandmother|grandfather|mum|mother|dad|father|neighbour) is (8|9)\d|(8|9)\d years? old|elderly|pensioner|in (his|her|their|my) (80s|90s|eighties|nineties)|8\d year old|9\d year old|newborn|baby|babies|infant|disabled|disability|vulnerable|poorly|unwell|medical condition|on oxygen)\b/.test(norm);
}

export function classify(norm) {
  if (has(norm, EMERGENCY.gas)) return 'gas_emergency';
  if (has(norm, EMERGENCY.co)) return 'co_emergency';
  if (has(norm, EMERGENCY.flood)) return 'flood';
  if (/\b(speak|talk|put me through) (to|with) (a |an |the |someone|somebody|real|actual|human|person|manager|owner|office|dan|priya)|\b(real|actual) (person|human)\b|\bhuman please\b|\boperator\b|\bnot a (robot|bot|machine)\b|\bare you a (robot|bot)\b/.test(norm)) return 'human';
  if (/\b(cancel|reschedule|re-?arrange|move (my|the|our) (appointment|booking|visit)|change (my|the) (appointment|booking))\b/.test(norm)) return 'cancel';
  if (/\b(how much|what('s| is| do| does) (it|the|a|your) (cost|price|charge)|price|prices|pricing|cost|costs|charge|charges|quote|rate|rates|fee)\b/.test(norm)) return 'price';
  if (/\b(opening (hours|times)|what time do you (open|close|shut)|are you open|when are you open|open (on |at )?(the )?(weekend|saturday|sunday)|work (on )?(weekends|saturdays|sundays)|hours)\b/.test(norm)) return 'hours';
  if (/\b(book|booking|appointment|come (out|round|over|and)|send (someone|an engineer|a plumber)|get (someone|an engineer|a plumber)|need (someone|an engineer|a plumber|a gas engineer)|visit|call ?out|fix|repair|sort (it|out))\b/.test(norm)) return 'book';
  if (extractService(norm)) return 'book';
  return null;
}

export function yesNo(norm) {
  const t = norm.replace(/^(oh |well |um |erm |so |hi |sorry )+/, '');
  if (NO.test(t)) return 'no';
  if (YES.test(t)) return 'yes';
  return null;
}

/** Everything the rules can read from one turn. */
export function understand(raw, ctx = {}) {
  const norm = normalize(raw);
  return {
    raw,
    norm,
    intent: classify(norm),
    service: extractService(norm),
    postcode: extractPostcode(norm),
    phone: extractPhone(norm),
    badPhone: looksLikeBadPhone(norm),
    name: extractName(norm, ctx),
    when: extractWhen(norm),
    vulnerable: extractVulnerable(norm),
    card: findCardNumber(norm),
    yesNo: yesNo(norm),
  };
}
