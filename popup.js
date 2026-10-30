// Alphabetizer popup logic. Sorting, comparison, and text tools with
// automatic language handling: the browser locale by default, Turkish
// collation whenever Turkish-only letters are present in the text.

const $ = id => document.getElementById(id);
const textA = $('textA'), textB = $('textB');
const counter = $('counter');
const primaryBtn = $('primaryBtn'), settingsBtn = $('settingsBtn'), advBtn = $('advBtn');
const undoBtn = $('undoBtn'), copyBtn = $('copyBtn');
const alphaToggle = $('alphaToggle'), exitCompareBtn = $('exitCompareBtn');
const swCompare = $('swCompare');
const diffPanel = $('diffPanel'), diffBody = $('diffBody');
const chipAdd = $('chipAdd'), chipDel = $('chipDel');
const srStatus = $('srStatus');

let settingsOpen = false, advancedOpen = false, compareOn = false;
let transformValue = 'none';
const undoStack = [];

// Re-alphabetize idempotence: when the text has not been edited since the
// last alphabetize, re-running uses the remembered pre-decoration source,
// so group headers, numbering, and custom text never compound.
let srcA = null, outA = null, srcB = null, outB = null;
// Where each item of outA came from (see alphabetizeText and keyRanges).
let outOriginsA = null;
function invalidateAlphaCache() { srcA = outA = srcB = outB = outOriginsA = null; }

/* ---------- Screen reader announcements ---------- */
function announce(text) {
  srStatus.textContent = '';
  setTimeout(() => { srStatus.textContent = text; }, 30);
}

/* ---------- State and layout ---------- */
function render() {
  document.body.classList.toggle('settings-open', settingsOpen);
  document.body.classList.toggle('advanced-open', advancedOpen);
  document.body.classList.toggle('compare-on', compareOn);
  settingsBtn.classList.toggle('active', settingsOpen);
  advBtn.classList.toggle('active', advancedOpen);
  settingsBtn.setAttribute('aria-expanded', String(settingsOpen));
  advBtn.setAttribute('aria-expanded', String(advancedOpen));
  primaryBtn.textContent = !compareOn ? 'Alphabetize'
    : (alphaToggle.checked ? 'Alphabetize + compare' : 'Compare');
  undoBtn.disabled = undoStack.length === 0;
}

settingsBtn.addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  if (!settingsOpen) advancedOpen = false;
  render(); save();
});

advBtn.addEventListener('click', () => {
  advancedOpen = !advancedOpen;
  if (advancedOpen) settingsOpen = true;
  render(); save();
});

function setCompare(on) {
  compareOn = on;
  swCompare.checked = on;
  if (!on) diffPanel.classList.remove('has-result');
  render(); save();
}
swCompare.addEventListener('change', () => setCompare(swCompare.checked));
exitCompareBtn.addEventListener('click', () => {
  setCompare(false);
  primaryBtn.focus();
});
alphaToggle.addEventListener('change', () => { render(); save(); });

/* ---------- Counter ---------- */
function updateCounter() {
  const t = textA.value;
  const lines = t === '' ? 0 : t.split('\n').length;
  const words = t.split(/\s+/).filter(w => w.length > 0).length;
  const chars = t.replace(/\s/g, '').length;
  counter.textContent = `${chars} characters · ${words} words · ${lines} lines`;
}

/* ---------- Undo ---------- */
function snapshot() {
  undoStack.push({ a: textA.value, b: textB.value });
  if (undoStack.length > 50) undoStack.shift();
  render();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  textA.value = s.a; textB.value = s.b;
  afterTextChange();
  render();
  if (undoBtn.disabled && (document.activeElement === undoBtn || document.activeElement === document.body)) {
    textA.focus();
  }
}
undoBtn.addEventListener('click', undo);

/* ---------- Copy ---------- */
function flashOk(btn) {
  btn.classList.add('ok');
  setTimeout(() => btn.classList.remove('ok'), 900);
}
function copyResult() {
  navigator.clipboard.writeText(textA.value).then(() => {
    flashOk(copyBtn);
    announce('Copied to clipboard');
  }).catch(() => announce('Copy failed'));
}
copyBtn.addEventListener('click', copyResult);

/* ---------- Language handling ---------- */
function resolveLocale(text) {
  return /[ıİğĞ]/.test(text) ? 'tr' : undefined;
}
function makeCollator(text) {
  return new Intl.Collator(resolveLocale(text), {
    sensitivity: $('swIgnoreCase').checked ? 'accent' : 'variant',
    numeric: $('swSortNumber').checked
  });
}

/* ---------- Transforms ---------- */
// Dotless and dotted capital i are distinct Turkish letters, not accents,
// so NFD stripping alone would leave them behind.
function foldAccents(s) {
  return s.replace(/ı/g, 'i').replace(/İ/g, 'I')
    .normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

const TRANSFORMS = {
  upper: (l, locale) => l.toLocaleUpperCase(locale),
  lower: (l, locale) => l.toLocaleLowerCase(locale),
  title: (l, locale) => l.replace(/\S+/g, w =>
    w.charAt(0).toLocaleUpperCase(locale) + w.slice(1).toLocaleLowerCase(locale)),
  sentence: (l, locale) => {
    const low = l.toLocaleLowerCase(locale);
    const m = low.match(/\p{L}/u);
    if (!m) return low;
    return low.slice(0, m.index) + low.charAt(m.index).toLocaleUpperCase(locale) + low.slice(m.index + 1);
  },
  trim: l => l.trim(),
  collapse: l => l.replace(/\s+/g, ' ').trim(),
  accents: l => foldAccents(l),
  slug: (l, locale) => foldAccents(l.toLocaleLowerCase(locale))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
};

/* ---------- Sort from character ---------- */
const sortFromInput = $('sortFrom');

// 1 means a normal whole-line sort. Anything unparsable or below 1 counts
// as 1, so a half-typed entry never breaks sorting.
function sortFromValue() {
  const n = Math.floor(Number(sortFromInput.value));
  return n >= 1 ? Math.min(n, 999) : 1;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Printable ASCII is one character per code unit, so those items skip the
// segmenter, which keeps long lists fast.
const PLAIN_ASCII = /^[\t\n -~]*$/;

// Where the nth character of s sits, as [start, end) offsets, or null when
// s is too short. Characters are grapheme clusters, so an accented letter
// or an emoji counts once, and leading whitespace is not counted.
function nthCharRange(s, n) {
  const lead = s.length - s.trimStart().length;
  // Every character is at least one code unit, so short items stop here.
  if (s.length - lead < n) return null;
  if (PLAIN_ASCII.test(s)) return [lead + n - 1, lead + n];
  let count = 0;
  for (const { segment, index } of graphemes.segment(s.slice(lead))) {
    if (++count === n) return [lead + index, lead + index + segment.length];
  }
  return null;
}

// What a line sorts by when sorting from character n: the rest of the line
// from that character on, so ties fall to the characters after it.
function sortKeyFrom(line, n) {
  const range = nthCharRange(line, n);
  return range ? line.slice(range[0]) : null;
}

function sortFromChanged() {
  sortFromInput.classList.toggle('on', sortFromValue() > 1);
  renderBackdrop();
  save();
}

function stepSortFrom(delta) {
  const n = Math.min(999, Math.max(1, sortFromValue() + delta));
  sortFromInput.value = n;
  sortFromChanged();
  announce(n > 1 ? `Sorting from character ${n}` : 'Sorting from the start');
}

$('sortFromDec').addEventListener('click', () => stepSortFrom(-1));
$('sortFromInc').addEventListener('click', () => stepSortFrom(1));
sortFromInput.addEventListener('input', sortFromChanged);
sortFromInput.addEventListener('change', () => {
  sortFromInput.value = sortFromValue();
  sortFromChanged();
});
// Items are counted per delimiter, so the boxes move when it changes.
$('delimiter').addEventListener('input', () => renderBackdrop());

/* ---------- Alphabetize ---------- */
function alphabetizeText(text) {
  if (text.trim() === '') return { text, origins: null };
  const delim = $('delimiter').value || '\n';
  const locale = resolveLocale(text) || navigator.language;
  const from = sortFromValue();
  let lines = text.split(delim);

  if ($('swRemoveEmpty').checked) lines = lines.filter(l => l.trim().length > 0);

  // Keys come from the lines as typed, before any transform, so the boxed
  // character is always the one a line sorts by.
  const transformFn = TRANSFORMS[transformValue];
  let items = lines.map(src => ({
    src,
    l: transformFn ? transformFn(src, locale) : src,
    key: from > 1 ? sortKeyFrom(src, from) : null
  }));

  const collator = makeCollator(text);
  const desc = $('orderDesc').checked;
  if (from > 1) {
    // Lines too short to have the character go last, in either order.
    const keyed = items.filter(it => it.key !== null)
      .sort((a, b) => collator.compare(a.key, b.key) || collator.compare(a.l, b.l));
    const short = items.filter(it => it.key === null)
      .sort((a, b) => collator.compare(a.l, b.l));
    if (desc) { keyed.reverse(); short.reverse(); }
    items = keyed.concat(short);
  } else {
    items.sort((a, b) => collator.compare(a.l, b.l));
    if (desc) items.reverse();
  }
  lines = items.map(it => it.l);

  // Group headings follow what each line sorts by.
  const keys = items.map(it => {
    const ch = (from > 1 ? (it.key ?? '') : it.l.trimStart()).charAt(0);
    return /\p{L}/u.test(ch) ? ch.toLocaleUpperCase(locale) : '#';
  });

  // Where each output line came from, so boxes on freshly sorted text land
  // on the character it sorted by. skip is what numbering and custom text
  // add in front, shift is how far Trim moved the line, and a null shift
  // means a transform rewrote it, so its box can't be placed. Headings are
  // null.
  const numbering = $('swNumbering').checked;
  const custom = $('customText').value;
  const customAtStart = !!custom && !$('posEnd').checked;
  let origins = items.map(({ src, l }, i) => ({
    src,
    skip: (numbering ? String(i + 1).length + 2 : 0) + (customAtStart ? custom.length : 0),
    shift: l.trim().length === src.trim().length
      ? (l.length - l.trimStart().length) - (src.length - src.trimStart().length)
      : null
  }));

  if (numbering) lines = lines.map((l, i) => `${i + 1}. ${l}`);

  if (custom) {
    lines = customAtStart ? lines.map(l => `${custom}${l}`) : lines.map(l => `${l}${custom}`);
  }

  if ($('swGroupLetter').checked) {
    const grouped = [], groupedOrigins = [];
    let prev = null;
    lines.forEach((l, i) => {
      if (keys[i] !== prev) { grouped.push(keys[i]); groupedOrigins.push(null); prev = keys[i]; }
      grouped.push(l);
      groupedOrigins.push(origins[i]);
    });
    lines = grouped;
    origins = groupedOrigins;
  }

  return { text: lines.join(delim), origins };
}

function runAlphabetize() {
  snapshot();
  const inputA = (outA !== null && textA.value === outA) ? srcA : textA.value;
  const inputB = (outB !== null && textB.value === outB) ? srcB : textB.value;
  const resultA = alphabetizeText(inputA);
  textA.value = resultA.text;
  const doB = compareOn && alphaToggle.checked;
  if (doB) textB.value = alphabetizeText(inputB).text;
  invalidateAlphaCache();
  srcA = inputA; outA = textA.value;
  outOriginsA = { delim: $('delimiter').value || '\n', origins: resultA.origins };
  if (doB) { srcB = inputB; outB = textB.value; }
  afterTextChange({ sorted: true });
  if ($('swAutoCopy').checked) copyResult();
}

primaryBtn.addEventListener('click', () => {
  if (!compareOn) { runAlphabetize(); return; }
  if (alphaToggle.checked) runAlphabetize();
  runDiff();
});

/* ---------- Diff (line LCS) ---------- */
function splitLines(v) {
  return v === '' ? [] : v.split('\n');
}

function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: a[i] }); i++; }
    else { out.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}

let lastDiff = [];
function runDiff() {
  lastDiff = diffLines(splitLines(textA.value), splitLines(textB.value));
  diffBody.replaceChildren();
  let adds = 0, dels = 0;
  lastDiff.forEach(d => {
    const row = document.createElement('div');
    row.className = 'diff-line' + (d.t === '+' ? ' add' : d.t === '-' ? ' del' : '');
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = d.t === ' ' ? '' : d.t;
    row.appendChild(mark);
    if (d.t === ' ') {
      row.appendChild(document.createTextNode(d.s));
    } else {
      const w = document.createElement('span');
      w.className = d.t === '+' ? 'w-add' : 'w-del';
      w.textContent = d.s;
      row.appendChild(w);
      if (d.t === '+') adds++; else dels++;
    }
    diffBody.appendChild(row);
  });
  chipAdd.textContent = `+${adds}`;
  chipDel.textContent = `-${dels}`;
  diffPanel.classList.add('has-result');
  announce(`Compared: ${adds} addition${adds === 1 ? '' : 's'}, ${dels} deletion${dels === 1 ? '' : 's'}`);
}

$('swapBtn').addEventListener('click', () => {
  snapshot();
  const tmp = textA.value; textA.value = textB.value; textB.value = tmp;
  afterTextChange();
  if (diffPanel.classList.contains('has-result')) runDiff();
});

$('copyDiffBtn').addEventListener('click', () => {
  const patch = lastDiff.map(d => `${d.t === ' ' ? ' ' : d.t} ${d.s}`).join('\n');
  navigator.clipboard.writeText(patch).then(() => {
    flashOk($('copyDiffBtn'));
    announce('Diff copied to clipboard');
  }).catch(() => announce('Copy failed'));
});

/* ---------- Find and replace ---------- */
function clearRegexError() {
  $('regexError').classList.add('hidden');
  $('findInput').classList.remove('invalid');
  $('findInput').removeAttribute('aria-invalid');
  $('findInput').removeAttribute('aria-describedby');
}

function buildPattern() {
  const find = $('findInput').value;
  const useRegex = $('swRegex').checked;
  const wholeWord = $('swWholeWord').checked;
  const matchCase = $('swMatchCase').checked;

  let pattern = useRegex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let flags = 'gm' + (matchCase ? '' : 'i');
  if (wholeWord) {
    if (useRegex) {
      pattern = `\\b(?:${pattern})\\b`;
    } else {
      // Unicode-aware word boundaries, so whole-word works for Turkish
      // and other non-ASCII letters too.
      pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
      flags += 'u';
    }
  }
  return { pattern, flags, useRegex };
}

function showRegexError() {
  $('regexError').classList.remove('hidden');
  $('findInput').classList.add('invalid');
  $('findInput').setAttribute('aria-invalid', 'true');
  $('findInput').setAttribute('aria-describedby', 'regexError');
  announce('Invalid regular expression');
}

function buildReplacement() {
  const raw = $('replaceInput').value;
  // In literal mode, $ in the replacement must not act as a group reference.
  return $('swRegex').checked ? raw : raw.replace(/\$/g, '$$$$');
}

/* ---------- Match highlighting and navigation ---------- */
const backdropA = $('backdropA');
const findCount = $('findCount');
const prevMatchBtn = $('prevMatchBtn'), nextMatchBtn = $('nextMatchBtn');
const replaceOneBtn = $('replaceOneBtn');
let findMatches = [];
let currentMatch = -1;

function syncBackdropScroll() {
  backdropA.scrollTop = textA.scrollTop;
  backdropA.scrollLeft = textA.scrollLeft;
}
textA.addEventListener('scroll', syncBackdropScroll);

// Where the sort-from character sits on every item of the main text box.
// Freshly sorted text maps each item back to its source line, because
// numbering, custom text, and transforms can move or rewrite characters,
// and sorting again starts from that source.
function keyRanges() {
  const n = sortFromValue();
  if (n < 2) return [];
  const text = textA.value;
  const delim = $('delimiter').value || '\n';
  const items = text.split(delim);
  const fresh = outA !== null && text === outA && outOriginsA?.delim === delim
    && outOriginsA.origins?.length === items.length ? outOriginsA.origins : null;
  const ranges = [];
  for (let i = 0, pos = 0; i < items.length && ranges.length < 5000; i++) {
    const r = fresh ? originRange(fresh[i], n) : nthCharRange(items[i], n);
    if (r) ranges.push({ start: pos + r[0], end: pos + r[1] });
    pos += items[i].length + delim.length;
  }
  return ranges;
}

// Where the sort-from character landed in a freshly sorted item, or null
// for a heading or a line a transform rewrote.
function originRange(origin, n) {
  if (!origin || origin.shift === null) return null;
  const r = nthCharRange(origin.src, n);
  const offset = origin.skip + origin.shift;
  return r && [r[0] + offset, r[1] + offset];
}

function renderBackdrop() {
  backdropA.replaceChildren();
  const keys = keyRanges();
  if (!findMatches.length && !keys.length) return;
  const text = textA.value;
  const frag = document.createDocumentFragment();
  let k = 0;
  // Appends text[from, to) to parent, boxing the sort-from characters in it.
  // A box that would straddle the edge of a match is skipped.
  const append = (parent, from, to) => {
    let pos = from;
    while (k < keys.length && keys[k].end <= to) {
      const { start, end } = keys[k++];
      if (start < pos) continue;
      if (start > pos) parent.appendChild(document.createTextNode(text.slice(pos, start)));
      const box = document.createElement('span');
      box.className = 'key';
      box.textContent = text.slice(start, end);
      parent.appendChild(box);
      pos = end;
    }
    if (to > pos) parent.appendChild(document.createTextNode(text.slice(pos, to)));
  };
  let pos = 0;
  findMatches.forEach((mt, i) => {
    append(frag, pos, mt.start);
    const mark = document.createElement('mark');
    if (i === currentMatch) mark.className = 'current';
    append(mark, mt.start, mt.end);
    frag.appendChild(mark);
    pos = mt.end;
  });
  append(frag, pos, text.length);
  frag.appendChild(document.createTextNode('\n'));
  backdropA.appendChild(frag);
  // Compensate for the textarea scrollbar so line wrapping stays identical.
  backdropA.style.right = `${textA.offsetWidth - textA.clientWidth - 2}px`;
  syncBackdropScroll();
}

function updateFindUi() {
  const hasFind = $('findInput').value !== '';
  findCount.textContent = !hasFind ? ''
    : findMatches.length === 0 ? 'No matches'
    : `${currentMatch + 1} of ${findMatches.length}`;
  const none = findMatches.length === 0;
  prevMatchBtn.disabled = none;
  nextMatchBtn.disabled = none;
  replaceOneBtn.disabled = none;
}

function updateFindHighlights(preserve = false) {
  findMatches = [];
  const find = $('findInput').value;
  if (find) {
    let re = null;
    const spec = buildPattern();
    try { re = new RegExp(spec.pattern, spec.flags); } catch {}
    if (re) {
      const text = textA.value;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        findMatches.push({ start: m.index, end: m.index + m[0].length });
        if (findMatches.length >= 2000) break;
      }
    }
  }
  if (!preserve || currentMatch < 0 || currentMatch >= findMatches.length) {
    currentMatch = findMatches.length ? Math.max(0, Math.min(currentMatch, findMatches.length - 1)) : -1;
    if (!preserve) currentMatch = findMatches.length ? 0 : -1;
  }
  renderBackdrop();
  updateFindUi();
}

function scrollCurrentIntoView() {
  const el = backdropA.querySelector('mark.current');
  if (el) textA.scrollTop = Math.max(0, el.offsetTop - textA.clientHeight / 2);
}

function goToMatch(delta) {
  if (!findMatches.length) return;
  currentMatch = (currentMatch + delta + findMatches.length) % findMatches.length;
  renderBackdrop();
  updateFindUi();
  scrollCurrentIntoView();
}

prevMatchBtn.addEventListener('click', () => goToMatch(-1));
nextMatchBtn.addEventListener('click', () => goToMatch(1));
$('findInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    goToMatch(e.shiftKey ? -1 : 1);
  }
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => renderBackdrop()).observe(textA);
}

/* ---------- Replace actions ---------- */
replaceOneBtn.addEventListener('click', () => {
  if (currentMatch < 0 || !findMatches.length) return;
  const { start, end } = findMatches[currentMatch];
  const spec = buildPattern();
  let anchored;
  try {
    anchored = new RegExp(`^(?:${spec.pattern})$`, spec.flags.replace(/[gm]/g, ''));
  } catch {
    showRegexError();
    return;
  }
  clearRegexError();
  snapshot();
  const before = textA.value;
  const keepIdx = currentMatch;
  textA.value = before.slice(0, start)
    + before.slice(start, end).replace(anchored, buildReplacement())
    + before.slice(end);
  afterTextChange();
  currentMatch = findMatches.length ? Math.min(keepIdx, findMatches.length - 1) : -1;
  renderBackdrop();
  updateFindUi();
  scrollCurrentIntoView();
});

$('replaceAllBtn').addEventListener('click', () => {
  if (!$('findInput').value) return;
  const spec = buildPattern();
  let re;
  try {
    re = new RegExp(spec.pattern, spec.flags);
  } catch {
    showRegexError();
    return;
  }
  clearRegexError();
  snapshot();
  textA.value = textA.value.replace(re, buildReplacement());
  afterTextChange();
});

$('findInput').addEventListener('input', () => {
  clearRegexError();
  updateFindHighlights(false);
});
['swRegex', 'swWholeWord', 'swMatchCase'].forEach(id => $(id).addEventListener('change', () => {
  clearRegexError();
  updateFindHighlights(false);
}));

/* ---------- Remove duplicates ---------- */
const dedupeUndoBtn = $('dedupeUndoBtn'), dedupeCallout = $('dedupeCallout');
const dedupeDetails = $('dedupeDetails'), dedupeMsg = $('dedupeMsg');
const dedupeSep = $('dedupeSep'), dedupeDetailsBtn = $('dedupeDetailsBtn');

function setDetailsOpen(open) {
  dedupeDetails.classList.toggle('hidden', !open);
  dedupeDetailsBtn.setAttribute('aria-expanded', String(open));
}

function hideDedupe() {
  dedupeUndoBtn.classList.add('hidden');
  dedupeCallout.classList.add('hidden');
  setDetailsOpen(false);
}

$('dedupeBtn').addEventListener('click', () => {
  const delim = $('delimiter').value || '\n';
  const text = textA.value;
  const locale = resolveLocale(text) || navigator.language;
  const ignore = $('swIgnoreCase').checked;
  const seen = new Map();
  const kept = [];
  const removed = new Map();

  text.split(delim).forEach(line => {
    const key = ignore ? line.toLocaleLowerCase(locale) : line;
    if (!seen.has(key)) {
      seen.set(key, line);
      kept.push(line);
    } else {
      const first = seen.get(key);
      removed.set(first, (removed.get(first) || 0) + 1);
    }
  });

  const total = [...removed.values()].reduce((a, b) => a + b, 0);
  hideDedupe();

  if (total === 0) {
    dedupeMsg.textContent = 'No duplicates found';
    dedupeSep.classList.add('hidden');
    dedupeDetailsBtn.classList.add('hidden');
    dedupeCallout.classList.remove('hidden');
    announce('No duplicates found');
    return;
  }

  snapshot();
  textA.value = kept.join(delim);
  invalidateAlphaCache();
  updateCounter();
  updateFindHighlights(true);
  save();

  const msg = `${total} duplicate${total === 1 ? '' : 's'} removed`;
  dedupeMsg.textContent = msg;
  announce(msg);
  dedupeSep.classList.remove('hidden');
  dedupeDetailsBtn.classList.remove('hidden');
  dedupeCallout.classList.remove('hidden');
  dedupeUndoBtn.classList.remove('hidden');

  dedupeDetails.replaceChildren();
  removed.forEach((count, line) => {
    const row = document.createElement('div');
    row.className = 'dup-item';
    const name = document.createElement('span');
    name.className = 'dup-name';
    name.textContent = line.trim() === '' ? '(empty line)' : line;
    name.title = line;
    const c = document.createElement('span');
    c.className = 'dup-count';
    c.textContent = `${count} removed`;
    row.append(name, c);
    dedupeDetails.appendChild(row);
  });
});

dedupeUndoBtn.addEventListener('click', () => {
  undo();
  $('dedupeBtn').focus();
});

dedupeDetailsBtn.addEventListener('click', e => {
  e.stopPropagation();
  setDetailsOpen(dedupeDetails.classList.contains('hidden'));
});
document.addEventListener('click', e => {
  if (!dedupeCallout.contains(e.target)) setDetailsOpen(false);
});

/* ---------- Clean markers and shuffle ---------- */
const MARKER = new RegExp('^\\s*(?:[-*+\\u2022\\u2023\\u25AA\\u2013\\u2014]|\\d+[.)])\\s+');
$('cleanBtn').addEventListener('click', () => {
  snapshot();
  textA.value = textA.value.split('\n').map(l => l.replace(MARKER, '')).join('\n');
  afterTextChange();
});

$('shuffleBtn').addEventListener('click', () => {
  snapshot();
  const delim = $('delimiter').value || '\n';
  const lines = textA.value.split(delim);
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  textA.value = lines.join(delim);
  afterTextChange();
});

/* ---------- Dropdown ---------- */
document.querySelectorAll('.dropdown').forEach(dd => {
  const trigger = dd.querySelector('.dd-trigger');
  const valueEl = dd.querySelector('.dd-value');
  const items = () => [...dd.querySelectorAll('.dd-item')];

  const setOpen = open => {
    dd.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', String(open));
  };

  trigger.addEventListener('click', () => setOpen(!dd.classList.contains('open')));

  items().forEach(item => {
    item.addEventListener('click', () => {
      items().forEach(i => i.setAttribute('aria-selected', 'false'));
      item.setAttribute('aria-selected', 'true');
      valueEl.textContent = item.textContent;
      transformValue = item.dataset.value;
      setOpen(false);
      trigger.focus();
      save();
    });
  });

  dd.addEventListener('keydown', e => {
    const open = dd.classList.contains('open');
    const list = items();
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        list[0].focus();
      } else {
        const idx = list.indexOf(document.activeElement);
        const next = idx === -1 ? 0
          : e.key === 'ArrowDown' ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
        list[next].focus();
      }
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      list[0].focus();
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      list[list.length - 1].focus();
    }
  });

  dd.addEventListener('focusout', e => {
    if (!dd.contains(e.relatedTarget)) setOpen(false);
  });
});
document.addEventListener('click', e => {
  document.querySelectorAll('.dropdown.open').forEach(dd => {
    if (!dd.contains(e.target)) {
      dd.classList.remove('open');
      dd.querySelector('.dd-trigger').setAttribute('aria-expanded', 'false');
    }
  });
});

/* ---------- Help modal ---------- */
const helpModal = $('helpModal'), helpBtn = $('helpBtn'), helpCloseBtn = $('helpCloseBtn');
function setHelpOpen(open) {
  helpModal.classList.toggle('hidden', !open);
  if (open) helpCloseBtn.focus();
  else helpBtn.focus();
}
helpBtn.addEventListener('click', () => setHelpOpen(true));
helpCloseBtn.addEventListener('click', () => setHelpOpen(false));
helpModal.addEventListener('click', e => { if (e.target === helpModal) setHelpOpen(false); });

/* ---------- Support menu ---------- */
// One-time Whop checkout links, one per amount. Changing a link is a
// one-line edit here, and forks can point these at their own.
const SUPPORT_LINKS = {
  2: 'https://whop.com/checkout/ch_XAGoYJwurD7k0wJ/',
  5: 'https://whop.com/checkout/ch_2bc73z7VETN5gQ4/',
  10: 'https://whop.com/checkout/ch_nOTUG4KST0xJ9bC/'
};

const supportWrap = $('supportWrap'), supportBtn = $('supportBtn');
const supportItems = [...supportWrap.querySelectorAll('.support-item')];

// Plain links that open a new tab: no permission needed, and nothing from
// the popup goes along with them, so the text still never leaves the device.
supportItems.forEach(a => { a.href = SUPPORT_LINKS[a.dataset.amount]; });

const supportIsOpen = () => supportWrap.classList.contains('open');
function setSupportOpen(open) {
  supportWrap.classList.toggle('open', open);
  supportBtn.setAttribute('aria-expanded', String(open));
}

// A disclosure, not a menu: focus stays on the heart, and Tab moves on into
// the links because they come right after it in the page.
supportBtn.addEventListener('click', () => setSupportOpen(!supportIsOpen()));

supportItems.forEach(a => a.addEventListener('click', () => {
  setSupportOpen(false);
  supportBtn.focus();
}));

// Arrow keys as an extra, moving the same way as the Transform dropdown
supportWrap.addEventListener('keydown', e => {
  const open = supportIsOpen();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) {
      setSupportOpen(true);
      supportItems[0].focus();
    } else {
      const idx = supportItems.indexOf(document.activeElement);
      const next = idx === -1 ? 0
        : e.key === 'ArrowDown' ? Math.min(idx + 1, supportItems.length - 1) : Math.max(idx - 1, 0);
      supportItems[next].focus();
    }
  } else if (e.key === 'Home' && open) {
    e.preventDefault();
    supportItems[0].focus();
  } else if (e.key === 'End' && open) {
    e.preventDefault();
    supportItems[supportItems.length - 1].focus();
  }
});

supportWrap.addEventListener('focusout', e => {
  if (!supportWrap.contains(e.relatedTarget)) setSupportOpen(false);
});
document.addEventListener('click', e => {
  if (supportIsOpen() && !supportWrap.contains(e.target)) setSupportOpen(false);
});

/* ---------- Keyboard shortcuts ---------- */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !helpModal.classList.contains('hidden')) {
    e.preventDefault();
    setHelpOpen(false);
    return;
  }
  if (e.key === 'Escape' && supportIsOpen()) {
    e.preventDefault();
    setSupportOpen(false);
    supportBtn.focus();
    return;
  }
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); primaryBtn.click(); }
  else if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); copyResult(); }
  else if (e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    if (!(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault(); undo();
    }
  }
  else if (e.key === 'Escape' && e.target instanceof Element && e.target.classList.contains('help')) {
    e.preventDefault();
    e.target.blur();
  }
});

/* ---------- Persistence ---------- */
// Settings go to chrome.storage.sync (they roam with the Chrome profile),
// text goes to chrome.storage.local (sync quotas are too small for long
// lists). Saves are debounced and settings are only written when they
// actually change, so typing never burns the sync write quota. When
// Remember text is off, only the opt-out flag itself is persisted.
// Falls back to localStorage when opened as a plain page.
const STORE_KEY = 'alphabetizer-state';
const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage;

const controlIds = ['swIgnoreCase', 'swSortNumber', 'swRemoveEmpty', 'swNumbering',
  'swRemember', 'swAutoCopy', 'swRegex', 'swMatchCase', 'swWholeWord', 'swGroupLetter',
  'orderAsc', 'orderDesc', 'posStart', 'posEnd', 'alphaToggle'];
const textIds = ['customText', 'delimiter', 'findInput', 'replaceInput', 'sortFrom'];

function fbRead() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function fbWrite(patch) {
  localStorage.setItem(STORE_KEY, JSON.stringify({ ...fbRead(), ...patch }));
}

function readStore() {
  if (hasChromeStorage) {
    return Promise.all([
      chrome.storage.sync.get('settings'),
      chrome.storage.local.get('textState')
    ]).then(([s, l]) => ({ settings: s.settings, textState: l.textState }));
  }
  return Promise.resolve(fbRead());
}

function writeSettings(settings) {
  if (hasChromeStorage) chrome.storage.sync.set({ settings }).catch(() => {});
  else fbWrite({ settings });
}
function writeText(textState) {
  if (hasChromeStorage) chrome.storage.local.set({ textState }).catch(() => {});
  else fbWrite({ textState });
}
function removeText() {
  if (hasChromeStorage) chrome.storage.local.remove('textState').catch(() => {});
  else fbWrite({ textState: undefined });
}

let saveTimer = null;
let lastSettingsJson = null;

function doSave() {
  saveTimer = null;
  if (!$('swRemember').checked) {
    const optOut = { checks: { swRemember: false } };
    const json = JSON.stringify(optOut);
    if (json !== lastSettingsJson) {
      writeSettings(optOut);
      lastSettingsJson = json;
      removeText();
    }
    return;
  }
  const settings = {
    transformValue, settingsOpen, advancedOpen, compareOn,
    checks: Object.fromEntries(controlIds.map(id => [id, $(id).checked])),
    texts: Object.fromEntries(textIds.map(id => [id, $(id).value]))
  };
  const json = JSON.stringify(settings);
  if (json !== lastSettingsJson) {
    writeSettings(settings);
    lastSettingsJson = json;
  }
  writeText({ a: textA.value, b: textB.value });
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 250);
}

function flushSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    doSave();
  }
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

function applyState(settings, textState) {
  if (textState) {
    textA.value = textState.a ?? '';
    textB.value = textState.b ?? '';
  }
  if (!settings) return;
  controlIds.forEach(id => { if (settings.checks && id in settings.checks) $(id).checked = settings.checks[id]; });
  textIds.forEach(id => { if (settings.texts && id in settings.texts) $(id).value = settings.texts[id]; });
  transformValue = settings.transformValue || 'none';
  document.querySelectorAll('#transformDd .dd-item').forEach(i => {
    const sel = i.dataset.value === transformValue;
    i.setAttribute('aria-selected', String(sel));
    if (sel) $('ddValue').textContent = i.textContent;
  });
  settingsOpen = !!settings.settingsOpen;
  advancedOpen = !!settings.advancedOpen;
  compareOn = !!settings.compareOn;
  swCompare.checked = compareOn;
  sortFromInput.value = sortFromValue();
  sortFromInput.classList.toggle('on', sortFromValue() > 1);
}

// sorted: the text came straight from Alphabetize, so keep the
// re-alphabetize cache it just set.
function afterTextChange({ sorted = false } = {}) {
  updateCounter();
  save();
  hideDedupe();
  if (!sorted) invalidateAlphaCache();
  updateFindHighlights(true);
}
textA.addEventListener('input', () => afterTextChange());
textB.addEventListener('input', () => { save(); srcB = outB = null; });
[...controlIds, ...textIds].forEach(id => {
  $(id).addEventListener('change', save);
  $(id).addEventListener('input', save);
});

/* ---------- Init ---------- */
async function init() {
  try {
    const { settings, textState } = await readStore();
    if (settings?.checks?.swRemember === false) {
      $('swRemember').checked = false;
      lastSettingsJson = JSON.stringify({ checks: { swRemember: false } });
    } else {
      applyState(settings, textState);
      if (settings) lastSettingsJson = null;
    }
  } catch {
    // Corrupt or unavailable storage: start fresh.
  }
  updateCounter();
  render();
  updateFindHighlights(false);
  textA.focus();
}
init();
