// Turns a raw speech-to-text transcript into text the rules can read.
// Phone calls arrive as words ("oh seven seven double oh"), without punctuation,
// with fillers and with postcodes spelled out ("L S six"). No I/O, runs in Node and the browser.

const DIGITS = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};
// Numbers that only appear as whole values (times, postcode districts), never inside phone numbers.
const TEENS = {
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
};
const FILLERS = /\b(um+|uh+|er+m?|erm|hmm+|like you know|you know)\b/g;

// Words a recogniser commonly produces instead of the trade word.
const MISHEARINGS = [
  [/\bboy?lers?\b/g, (m) => (m.endsWith('s') ? 'boilers' : 'boiler')],
  [/\bbowlers?\b/g, 'boiler'],
  [/\bbroiler\b/g, 'boiler'],
  [/\braider?ators?\b/g, 'radiator'],
  [/\bstop ?cock\b/g, 'stop tap'],
  [/\bsee ?pee ?twelve\b/g, 'cp12'],
  [/\bc ?p ?12\b/g, 'cp12'],
];

function isDigitWord(w) {
  return w in DIGITS || /^\d+$/.test(w);
}

/** Join runs of spoken digits ("oh seven seven double oh nine") into "077009". */
function joinSpokenDigits(words) {
  const out = [];
  let run = [];
  let runHasWord = false;
  const flush = () => {
    if (run.length) {
      // A lone "o"/"oh" that is not next to another number is an interjection, keep it as a word.
      if (run.length === 1 && runHasWord && (run[0].src === 'oh' || run[0].src === 'o')) out.push(run[0].src);
      else out.push(run.map((r) => r.d).join(''));
    }
    run = [];
    runHasWord = false;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if ((w === 'double' || w === 'triple') && next && isDigitWord(next) && (next in DIGITS || next.length === 1)) {
      const d = next in DIGITS ? DIGITS[next] : next;
      run.push({ d: d.repeat(w === 'double' ? 2 : 3), src: w });
      runHasWord = true;
      i++;
      continue;
    }
    if ((w === 'hundred' || w === 'thousand') && run.length) {
      run.push({ d: w === 'hundred' ? '00' : '000', src: w });
      continue;
    }
    if (w in DIGITS) {
      run.push({ d: DIGITS[w], src: w });
      runHasWord = true;
      continue;
    }
    if (/^\d+$/.test(w) && run.length) {
      run.push({ d: w, src: w });
      continue;
    }
    if (/^\d+$/.test(w)) {
      run.push({ d: w, src: w });
      continue;
    }
    flush();
    out.push(w);
  }
  flush();
  return out;
}

/**
 * Normalise a transcript. Returns lower-case text with digits as numerals,
 * postcode districts as "ls6", and fillers removed.
 */
export function normalize(raw) {
  let t = String(raw || '').toLowerCase();
  t = t.replace(/[’']/g, "'").replace(/[“”"]/g, ' ');
  t = t.replace(/\+44\s*\(?0?\)?\s*/g, '0');
  t = t.replace(/(\d)[\s-]+(?=\d)/g, '$1 '); // keep digit groups apart for now, joined below
  t = t.replace(/[^a-z0-9£'\s]/g, ' ');
  t = t.replace(FILLERS, ' ');
  t = t.replace(/\b(isn|doesn|won|can|don|didn|hasn|wasn|aren|haven)t\b/g, "$1't").replace(/\bthats\b/g, "that's").replace(/\bim\b/g, "i'm");
  for (const [re, rep] of MISHEARINGS) t = t.replace(re, rep);

  // Postcode district spoken as letters: "l s six", "el es 6", "elle ess sixteen".
  t = t.replace(/\b(?:l|el|elle)\s+(?:s|es|ess)\s+([a-z]+|\d{1,2})\b/g, (m, n) => {
    const v = TEENS[n] || DIGITS[n] || (/^\d{1,2}$/.test(n) ? n : null);
    return v ? ` ls${v} ` : m;
  });
  t = t.replace(/\bls\s+(\d{1,2})\b/g, 'ls$1');
  t = t.replace(/\bls\s+([a-z]+)\b/g, (m, n) => (TEENS[n] || DIGITS[n] ? `ls${TEENS[n] || DIGITS[n]}` : m));

  let words = t.split(/\s+/).filter(Boolean);
  words = joinSpokenDigits(words);
  t = words.join(' ');
  // Whole numbers used for times: "nine thirty" stays readable by the time parser.
  for (const [w, v] of Object.entries(TEENS)) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), v);
  t = t.replace(/\bc ?p ?12\b/g, 'cp12');
  return t.replace(/\s+/g, ' ').trim();
}

/** All digit runs in normalised text, with spaces between groups merged when they form a phone number. */
export function digitRuns(norm) {
  const merged = norm.replace(/(\d)\s+(?=\d)/g, '$1');
  return merged.match(/\d+/g) || [];
}
