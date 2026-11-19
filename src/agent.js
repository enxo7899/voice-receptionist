// The receptionist: one function, turn(), that takes what the caller said and returns
// what to say back plus the actions for the business (book, text, transfer, alert).
// Pure logic: the browser demo, the tests, the evaluation and the webhook server all call it.

import { understand, extractName } from './nlu.js';
import { findSlots, describeSlot, book, resolveDay } from './calendar.js';
import { SAFETY, PRICE_FALLBACK, guardReply, redactCards, inServiceArea, bookingBlockers, readBack, formatPhone } from './policy.js';

export function greeting(business) {
  return `${business.name.replace('&', 'and')}, you're through to the virtual receptionist. How can I help?`;
}

export function newCall(business, { callId = 'call-1' } = {}) {
  return {
    callId,
    stage: 'open',
    mode: null, // 'book' | 'message'
    awaiting: null,
    job: { service: null, postcode: null, name: null, phone: null, phoneConfirmed: false, day: null, part: null, vulnerable: false },
    offered: null,
    declined: [],
    dayAsked: false,
    misses: 0,
    outcome: null,
    emergency: null,
    booking: null,
    priceQuoted: null,
    flags: [],
    blocked: [],
    transcript: [{ who: 'agent', text: greeting(business) }],
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));
const label = (b, id) => b.services[id]?.label.replace(/ \(free survey\)$/, '').toLowerCase();

function priceLine(b, service) {
  const s = b.services[service];
  if (!s) return PRICE_FALLBACK;
  return s.price == null ? `For a ${label(b, service)} we do ${s.priceText}.` : `A ${label(b, service)} is ${s.priceText}.`;
}

function close(s, outcome) {
  s.stage = 'closed';
  s.awaiting = null;
  if (outcome) s.outcome = outcome;
}

/** Ask for whatever the booking (or message) still needs, or offer a slot. */
function nextStep(s, ctx, say, actions) {
  const b = ctx.business;
  const j = s.job;
  if (s.mode === 'book' && !j.service) {
    s.awaiting = 'service';
    return say("What's the job you need help with?");
  }
  if (s.mode === 'book' && !j.postcode) {
    s.awaiting = 'postcode';
    return say("What's the postcode where the work is?");
  }
  if (s.mode === 'book' && !inServiceArea(j.postcode, b)) {
    say(`I'm sorry, ${j.postcode} is outside the area we cover. We work across Leeds, postcodes LS1 to LS17, so we can't book a visit there.`);
    actions.push({ type: 'log_call', reason: 'outside_service_area', postcode: j.postcode });
    return close(s, 'out_of_area');
  }
  if (!j.name) {
    s.awaiting = 'name';
    return say('Can I take your name, please?');
  }
  if (!j.phone) {
    s.awaiting = 'phone';
    return say("And what's the best mobile or phone number to reach you on?");
  }
  if (!j.phoneConfirmed) {
    s.awaiting = 'confirm_phone';
    return say(`Let me read that back: ${readBack(j.phone)}. Is that right?`);
  }
  if (s.mode === 'message') {
    actions.push({ type: 'take_message', for: 'office', name: j.name, phone: j.phone, about: s.messageAbout || 'callback' });
    say(`Thanks ${j.name.split(' ')[0]}. I've passed that to the office and someone will call you back on ${formatPhone(j.phone)} today. Is there anything else?`);
    s.outcome = s.messageAbout === 'cancel' ? 'cancel_message' : 'callback';
    s.awaiting = 'anything_else';
    return;
  }
  if (j.vulnerable && !j.day) {
    j.day = 'asap';
    if (!s.flags.includes('priority_vulnerable')) s.flags.push('priority_vulnerable');
  }
  if (!j.day && !s.dayAsked) {
    s.dayAsked = true;
    s.awaiting = 'day';
    return say('Is there a day or time that suits you best?');
  }
  return offer(s, ctx, say);
}

function offer(s, ctx, say, prefix = '') {
  const j = s.job;
  const slots = findSlots(ctx.calendar, { day: j.day, part: j.part, skip: s.declined });
  if (!slots.length) {
    s.mode = 'message';
    s.messageAbout = 'no_slots';
    say(`${prefix}I'm sorry, I can't see a free slot in the next two weeks. I'll ask the office to call you back to fit you in.`);
    return nextStep(s, ctx, say, []);
  }
  const slot = slots[0];
  s.offered = slot;
  s.awaiting = 'offer';
  const wanted = j.day && !['asap', 'next week'].includes(j.day);
  const r = resolveDay(ctx.calendar, j.day);
  const missed = (wanted && r.exact && slot.date !== r.from) || (j.part && slot.part !== j.part);
  const asked = `${wanted ? j.day : ''}${j.part ? (j.part === 'am' ? ' morning' : ' afternoon') : ''}`.trim();
  const lead = missed && !s.declined.length ? `I don't have anything ${asked.replace(/^[a-z]/, (c) => c.toUpperCase())}. ` : '';
  say(`${prefix}${lead}${s.declined.length ? 'The next one I have is' : 'I can do'} ${describeSlot(ctx.calendar, slot)} with ${slot.engineer}. Shall I book that?`);
}

function tryBook(s, ctx, say, actions) {
  const b = ctx.business;
  const blockers = bookingBlockers(s.job, b, { emergency: s.emergency });
  if (blockers.length) {
    s.blocked.push({ rule: 'booking_blocked', reasons: blockers });
    s.offered = null;
    return nextStep(s, ctx, say, actions);
  }
  const res = book(ctx.calendar, s.offered.key, {
    service: s.job.service, name: s.job.name, phone: s.job.phone, postcode: s.job.postcode,
    priority: s.flags.includes('priority_vulnerable'), callId: s.callId,
  });
  if (!res.ok) {
    s.blocked.push({ rule: 'double_booking_prevented', slot: s.offered.key });
    s.declined.push(s.offered.key);
    s.offered = null;
    return offer(s, ctx, say, 'Sorry, that slot has just been taken. ');
  }
  s.booking = res.job;
  s.offered = null;
  actions.push({ type: 'book_job', job: res.job });
  const when = describeSlot(ctx.calendar, { date: res.job.date, part: res.job.part });
  actions.push({
    type: 'send_sms', to: s.job.phone,
    text: `${b.name}: ${res.job.engineer} will visit ${s.job.postcode} on ${when} for your ${label(b, s.job.service)}. Ref ${res.job.id}. Reply C to cancel.`,
  });
  if (res.job.priority) actions.push({ type: 'notify_owner', priority: 'high', text: `Priority job ${res.job.id}: vulnerable person without heating at ${s.job.postcode}. Booked first available slot; call them if you can come sooner.` });
  s.outcome = 'booked';
  s.awaiting = 'anything_else';
  say(`That's booked: ${when} with ${res.job.engineer}, reference ${res.job.id}. ${priceLine(b, s.job.service)} You'll get a text to confirm. Is there anything else?`);
}

/**
 * One caller turn. Returns { state, reply, actions }.
 * ctx = { business, calendar, rewrite? } where rewrite(reply) lets a test or the demo
 * stand in for an LLM that says something it shouldn't; the guard still runs after it.
 */
export function turn(ctx, prev, raw) {
  const b = ctx.business;
  const s = clone(prev);
  const actions = [];
  const parts = [];
  const say = (t) => { parts.push(t); };

  s.transcript.push({ who: 'caller', text: redactCards(raw) });
  if (s.stage === 'closed') return finish(ctx, s, ['The call has ended.'], actions);

  const u = understand(raw, { expectingName: s.awaiting === 'name' });
  let understood = false;

  if (u.card) {
    say(SAFETY.card());
    if (!s.flags.includes('card_details_refused')) s.flags.push('card_details_refused');
    understood = true;
  }

  // 1. Safety first, at any point in the call.
  if (u.intent === 'gas_emergency' || u.intent === 'co_emergency') {
    s.emergency = u.intent;
    say(u.intent === 'gas_emergency' ? SAFETY.gas(b) : SAFETY.co(b));
    actions.push({ type: 'log_emergency', kind: u.intent === 'gas_emergency' ? 'gas' : 'carbon_monoxide' });
    actions.push({ type: 'notify_owner', priority: 'urgent', text: `${u.intent === 'gas_emergency' ? 'Gas smell' : 'CO alarm'} reported${s.job.postcode ? ' at ' + s.job.postcode : ''}. Caller told to leave and call ${b.gasEmergencyNumber}. Not booked.` });
    close(s, u.intent);
    return finish(ctx, s, parts, actions);
  }
  if (u.intent === 'flood') {
    s.emergency = 'flood';
    say(SAFETY.flood(b));
    actions.push({ type: 'transfer_call', to: `on-call engineer (${b.onCall.name})`, number: b.onCall.number });
    actions.push({ type: 'notify_owner', priority: 'urgent', text: `Burst pipe or flooding${s.job.postcode ? ' at ' + s.job.postcode : ''}. Transferred to ${b.onCall.name}.` });
    close(s, 'flood_transfer');
    return finish(ctx, s, parts, actions);
  }
  if (u.intent === 'human') {
    say("Of course. I'll put you through to the office now.");
    actions.push({ type: 'transfer_call', to: 'office', number: b.phone });
    close(s, 'transfer');
    return finish(ctx, s, parts, actions);
  }

  // 2. Take any details the caller gave, in any order.
  const j = s.job;
  if (u.service && (s.awaiting !== 'confirm_phone')) { if (j.service !== u.service) understood = true; j.service = u.service; }
  if (u.postcode) { understood = true; j.postcode = u.postcode; }
  if (u.name && (s.awaiting === 'name' || !j.name)) { understood = true; j.name = u.name; }
  if (u.phone && !u.card) {
    understood = true;
    if (u.phone !== j.phone) { j.phone = u.phone; j.phoneConfirmed = false; }
  }
  if (u.when.day) { understood = true; j.day = u.when.day; }
  if (u.when.part) { understood = true; j.part = u.when.part; }
  if (u.vulnerable) { understood = true; j.vulnerable = true; }

  // 3. Answers to the question we just asked.
  const aw = s.awaiting;
  if (aw === 'confirm_phone' && !u.phone) {
    if (u.yesNo === 'yes') { j.phoneConfirmed = true; understood = true; }
    else if (u.yesNo === 'no') { j.phone = null; s.awaiting = 'phone'; say("Sorry about that. Could you give me the number again?"); return finish(ctx, s, parts, actions); }
  }
  if (aw === 'phone' && !u.phone && u.badPhone) {
    say("Sorry, I didn't get a full number there. Could you say it again, starting with the zero?");
    return finish(ctx, s, parts, actions);
  }
  if (aw === 'day' && !u.when.day && !u.when.part) {
    if (u.yesNo || /\b(no|not really|any|either|whenever)\b/.test(u.norm)) { j.day = 'asap'; understood = true; }
  }
  if (aw === 'offer') {
    if (u.yesNo === 'yes' && !u.when.day && !u.when.part) {
      tryBook(s, ctx, say, actions);
      return finish(ctx, s, parts, actions);
    }
    if (u.yesNo === 'no' || u.when.day || u.when.part) {
      understood = true;
      if (s.offered) s.declined.push(s.offered.key);
      s.offered = null;
      if (s.declined.length >= 3 && !u.when.day && !u.when.part) {
        s.mode = 'message';
        s.messageAbout = 'no_suitable_slot';
        say("No problem. I'll ask the office to call you to find a time that works.");
        nextStep(s, ctx, say, actions);
        return finish(ctx, s, parts, actions);
      }
    }
  }
  if (aw === 'book_after_price') {
    if (u.yesNo === 'yes' || u.intent === 'book' || u.postcode || u.phone || u.when.day || extractName(u.norm, { expectingName: true })) {
      s.mode = 'book'; understood = true;
      if (!j.name) j.name = extractName(u.norm, { expectingName: true });
    }
    else if (u.yesNo === 'no') { s.awaiting = 'anything_else'; say('No problem. Is there anything else I can help with?'); return finish(ctx, s, parts, actions); }
  }
  if (aw === 'anything_else' && !u.intent && !u.service) {
    if (u.yesNo === 'no' || /\b(that's all|thats all|that's it|nothing else|no thanks|thank(s| you)|bye|cheers)\b/.test(u.norm)) {
      say('Thanks for calling Brightwater. Bye for now.');
      close(s, s.outcome || 'info');
      return finish(ctx, s, parts, actions);
    }
    if (u.yesNo === 'yes') { s.awaiting = null; say('Go ahead, what can I help with?'); return finish(ctx, s, parts, actions); }
  }

  // 4. What they want.
  const intent = u.intent;
  if (intent === 'cancel') {
    understood = true;
    s.mode = 'message';
    s.messageAbout = 'cancel';
    say("I can't change bookings myself, but I'll pass it straight to the office and they'll text you to confirm.");
  } else if (intent === 'hours') {
    understood = true;
    say(`The office is open ${b.hours.office}. For burst pipes and flooding we're available ${b.hours.emergency}.`);
    if (!s.mode) { s.awaiting = 'anything_else'; s.outcome = s.outcome || 'info'; return finish(ctx, s, parts, actions); }
  } else if (intent === 'price') {
    understood = true;
    if (!j.service && /\bcall ?out\b/.test(u.norm)) {
      const oh = b.otherPrices.find((p) => /out-of-hours/i.test(p.label));
      say(`Our call-out is £${b.services.leak_repair.price} on weekdays and covers the first 30 minutes; the engineer quotes before any further work. ${oh.label} is £${oh.price}.`);
      s.awaiting = 'service';
      s.pendingPrice = true;
      say('What is the job, so I can check we can help?');
      s.outcome = 'price_given';
      return finish(ctx, s, parts, actions);
    } else if (j.service) {
      say(priceLine(b, j.service));
      s.priceQuoted = j.service;
      if (!s.mode) { s.awaiting = 'book_after_price'; s.outcome = 'price_given'; say('Would you like me to book that in?'); return finish(ctx, s, parts, actions); }
    } else if (u.norm.split(' ').length > 4) {
      say(PRICE_FALLBACK);
      say("I'll ask the office to call you back with a quote.");
      s.mode = 'message';
      s.messageAbout = 'quote';
    } else {
      s.awaiting = 'service';
      s.pendingPrice = true;
      say('Which job is it for? For example a boiler service, a blocked drain or a leak.');
      return finish(ctx, s, parts, actions);
    }
  } else if (intent === 'book' || (!s.mode && !s.pendingPrice && aw !== 'book_after_price' && (j.service || u.postcode || u.name || u.phone || u.vulnerable))) {
    understood = true;
    if (!s.mode) s.mode = 'book';
  }

  if (s.pendingPrice && j.service && aw === 'service') {
    s.pendingPrice = false;
    s.priceQuoted = j.service;
    say(priceLine(b, j.service));
    if (!s.mode) { s.awaiting = 'book_after_price'; s.outcome = 'price_given'; say('Would you like me to book that in?'); return finish(ctx, s, parts, actions); }
  }

  // A plain "no" to a question means they don't want to go on, not that we misheard.
  if (!understood && u.yesNo === 'no' && ['service', 'postcode', 'name', 'phone', 'day'].includes(aw)) {
    s.mode = null;
    s.awaiting = 'anything_else';
    say('No problem. Is there anything else I can help with?');
    return finish(ctx, s, parts, actions);
  }
  if (!understood && !(aw === 'confirm_phone' && j.phoneConfirmed)) {
    s.misses += 1;
    if (s.misses >= 2) {
      say("I'm sorry, I'm not catching that. I'll put you through to someone in the office.");
      actions.push({ type: 'transfer_call', to: 'office', number: b.phone, reason: 'not_understood' });
      close(s, 'transfer_fallback');
      return finish(ctx, s, parts, actions);
    }
    say("Sorry, I didn't catch that.");
    if (!s.mode) { say('Are you calling to book a job, or about something else?'); return finish(ctx, s, parts, actions); }
  }

  if (s.mode) nextStep(s, ctx, say, actions);
  else if (!s.awaiting || s.awaiting === 'service') { s.awaiting = 'anything_else'; say('Is there anything else I can help with?'); }
  return finish(ctx, s, parts, actions);
}

function finish(ctx, s, parts, actions) {
  let reply = parts.join(' ');
  if (ctx.rewrite) reply = ctx.rewrite(reply, s);
  const g = guardReply(reply, ctx.business);
  if (g.blocked) s.blocked.push(g.blocked);
  s.transcript.push({ who: 'agent', text: g.reply, blocked: g.blocked ? g.blocked.rule : undefined, original: g.blocked ? g.blocked.original : undefined });
  return { state: s, reply: g.reply, actions };
}

/** What the owner sees after the call. */
export function summarize(state, business) {
  const j = state.job;
  return {
    callId: state.callId,
    outcome: state.outcome || (state.stage === 'closed' ? 'ended' : 'in_progress'),
    name: j.name,
    phone: j.phone ? formatPhone(j.phone) : null,
    postcode: j.postcode,
    service: j.service ? business.services[j.service].label : null,
    booking: state.booking ? { id: state.booking.id, date: state.booking.date, part: state.booking.part, engineer: state.booking.engineer } : null,
    emergency: state.emergency,
    flags: state.flags,
    guardrailsTriggered: state.blocked.map((x) => x.rule),
    turns: state.transcript.length,
  };
}
