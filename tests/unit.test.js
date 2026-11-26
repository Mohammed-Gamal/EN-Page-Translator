/* Unit tests for the pure logic: the marker protocol that keeps inline markup
   intact, the Hungarian detection heuristic, and cache keys.
   Run with:  node --test tests/
   No browser or dependencies needed. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'extension', 'src');

/* splitJoined returns arrays created inside the vm realm, whose prototype is
   not the host Array.prototype, so deepStrictEqual rejects them. Copy into a
   host array before comparing. */
function plain(value) {
  return value === null ? null : Array.from(value);
}

function loadHUEN() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const files = [
    'shared/namespace.js',
    'shared/protocol.js',
    'shared/settings.js',
    'shared/languages.js',
    'shared/browser.js',
    'shared/lang.js',
    'shared/hash.js',
    'shared/glossary.js',
    'shared/engine.js',
    'content/tags.js',
    'content/segmenter.js',
  ];
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}

/* The sandbox is kept as well as HUEN: browser.js reads the global
   `navigator`, which the sandbox has to be given before each case. */
const SANDBOX = loadHUEN();
const HUEN = SANDBOX.HUEN;

test('buildJoined / splitJoined round-trips an untouched string', () => {
  const texts = ['A', 'kutya', 'fut a kertben'];
  const joined = HUEN.segmenter.buildJoined(texts);
  assert.strictEqual(joined, '{1} A {2} kutya {3} fut a kertben');
  assert.deepStrictEqual(plain(HUEN.segmenter.splitJoined(joined, 3)), texts);
});

test('splitJoined handles a realistic translated string', () => {
  // What a model plausibly returns for "{1} A {2} kutya {3} fut a kertben".
  const out = '{1} The {2} dog {3} runs in the garden';
  assert.deepStrictEqual(
    plain(HUEN.segmenter.splitJoined(out, 3)),
    ['The', 'dog', 'runs in the garden']
  );
});

test('splitJoined rejects a dropped marker', () => {
  assert.strictEqual(HUEN.segmenter.splitJoined('The dog {2} runs', 3), null);
});

test('splitJoined rejects reordered markers', () => {
  // Reordering would put English words into the wrong DOM nodes.
  assert.strictEqual(
    HUEN.segmenter.splitJoined('{2} dog {1} The {3} runs', 3),
    null
  );
});

test('splitJoined rejects a duplicated marker', () => {
  assert.strictEqual(
    HUEN.segmenter.splitJoined('{1} The {1} dog {3} runs', 3),
    null
  );
});

test('splitJoined handles a single-piece segment', () => {
  assert.deepStrictEqual(plain(HUEN.segmenter.splitJoined('{1} Hello there', 1)),
    ['Hello there']);
});

test('splitJoined tolerates empty pieces', () => {
  const parts = plain(HUEN.segmenter.splitJoined('{1} {2} Only the second', 2));
  assert.deepStrictEqual(parts, ['', 'Only the second']);
});

test('Hungarian text scores positive', () => {
  const samples = [
    'Az oldal használatához kérjük, fogadja el a feltételeket.',
    'Bejelentkezés után megtekintheti a számláit és a befizetéseit.',
    'A kormányhivatal ügyfélszolgálata hétfőtől péntekig tart nyitva.',
    'Tovább a részletekhez',
  ];
  for (const sample of samples) {
    const score = HUEN.lang.hungarianScore(sample);
    assert.ok(score > 0.06, `expected > 0.06 for "${sample}", got ${score}`);
  }
});

test('English text does not score as Hungarian', () => {
  const samples = [
    'Please accept the terms and conditions to continue using this site.',
    'Log in to view your invoices and payments.',
    'Read more about our products and services.',
  ];
  for (const sample of samples) {
    const score = HUEN.lang.hungarianScore(sample);
    assert.ok(score <= 0.06, `expected <= 0.06 for "${sample}", got ${score}`);
  }
});

test('the o-double-acute / u-double-acute letters are a strong signal', () => {
  // Nonsense words, but those two letters are effectively Hungarian-only.
  assert.ok(HUEN.lang.hungarianScore('Bővebben a gyűjtésről') > 0.3);
});

test('isTranslatable filters out noise', () => {
  const skip = ['', ' ', '12', '1 234 Ft', '->', '...', 'https://example.hu',
    'info@example.hu', 'OK', '#', '2024.01.15.'];
  for (const text of skip) {
    assert.strictEqual(HUEN.lang.isTranslatable(text), false,
      `expected "${text}" to be skipped`);
  }
  const keep = ['Kapcsolat', 'Tovább a részletekhez', 'Bejelentkezés'];
  for (const text of keep) {
    assert.strictEqual(HUEN.lang.isTranslatable(text), true,
      `expected "${text}" to be translated`);
  }
});

test('cache keys are stable and separate language pairs', () => {
  const a = HUEN.hash.cacheKey('Kapcsolat', 'hu', 'en');
  const b = HUEN.hash.cacheKey('Kapcsolat', 'hu', 'en');
  const c = HUEN.hash.cacheKey('Kapcsolat', 'hu', 'de');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('long strings fall back to a hashed key', () => {
  const long = 'a'.repeat(500);
  const key = HUEN.hash.cacheKey(long, 'hu', 'en');
  assert.ok(key.length < 60, 'hashed key should be short');
  assert.ok(key.includes('#500.'), 'key should record the length');
});

test('host matching covers subdomains and www', () => {
  assert.ok(HUEN.hostMatches(['telex.hu'], 'telex.hu'));
  assert.ok(HUEN.hostMatches(['telex.hu'], 'www.telex.hu'));
  assert.ok(HUEN.hostMatches(['telex.hu'], 'static.telex.hu'));
  assert.ok(!HUEN.hostMatches(['telex.hu'], 'nottelex.hu'));
  assert.ok(!HUEN.hostMatches(['telex.hu'], 'telex.hu.evil.com'));
});

test('mode gating behaves', () => {
  const base = HUEN.normalizeSettings({});
  assert.ok(HUEN.shouldAutoTranslate(base, 'telex.hu'));

  const off = HUEN.normalizeSettings({ enabled: false });
  assert.ok(!HUEN.shouldAutoTranslate(off, 'telex.hu'));

  const manual = HUEN.normalizeSettings({ mode: 'manual' });
  assert.ok(!HUEN.shouldAutoTranslate(manual, 'telex.hu'));

  const allow = HUEN.normalizeSettings({ mode: 'allowlist', allowlist: ['telex.hu'] });
  assert.ok(HUEN.shouldAutoTranslate(allow, 'telex.hu'));
  assert.ok(!HUEN.shouldAutoTranslate(allow, 'index.hu'));

  const deny = HUEN.normalizeSettings({ denylist: ['telex.hu'] });
  assert.ok(!HUEN.shouldAutoTranslate(deny, 'telex.hu'));
  assert.ok(HUEN.shouldAutoTranslate(deny, 'index.hu'));
});

test('denylist beats allowlist', () => {
  const s = HUEN.normalizeSettings({
    mode: 'allowlist', allowlist: ['telex.hu'], denylist: ['telex.hu'],
  });
  assert.ok(!HUEN.shouldAutoTranslate(s, 'telex.hu'));
});

/* ---------- settings normalisation ---------- */

test('normalizeSettings clamps numbers and rejects unknown modes', () => {
  const s = HUEN.normalizeSettings({
    mode: 'whatever', minScore: 9, cacheLimit: 2, translateTitle: 'yes',
  });
  assert.strictEqual(s.mode, 'auto');
  assert.strictEqual(s.minScore, 1);
  assert.strictEqual(s.cacheLimit, 500);
  assert.strictEqual(s.translateTitle, true);
});

test('normalizeSettings survives junk where a list belongs', () => {
  const s = HUEN.normalizeSettings({ allowlist: 'telex.hu', denylist: null });
  assert.deepStrictEqual(Array.from(s.allowlist), []);
  assert.deepStrictEqual(Array.from(s.denylist), []);
});

test('normalizeSettings canonicalises and deduplicates host lists', () => {
  const s = HUEN.normalizeSettings({
    allowlist: ['WWW.Telex.hu', ' telex.hu ', 'index.hu', ''],
  });
  assert.deepStrictEqual(Array.from(s.allowlist), ['telex.hu', 'index.hu']);
});

test('withHost adds, removes and never duplicates', () => {
  assert.deepStrictEqual(Array.from(HUEN.withHost([], 'telex.hu', true)), ['telex.hu']);
  assert.deepStrictEqual(
    Array.from(HUEN.withHost(['telex.hu'], 'www.telex.hu', true)), ['telex.hu']);
  assert.deepStrictEqual(
    Array.from(HUEN.withHost(['telex.hu', 'index.hu'], 'telex.hu', false)), ['index.hu']);
});

/* ---------- the shared status vocabulary ---------- */

test('every status has a label and a badge spec', () => {
  // The popup reads the labels and the service worker reads the badges. This is
  // what stops a new status being added to one and forgotten in the other.
  for (const status of Object.values(HUEN.STATUS)) {
    const info = HUEN.statusInfo(status);
    assert.ok(info.label, `${status} has no label`);
    assert.ok(typeof info.badge === 'string', `${status} has no badge text`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(info.badgeColor), `${status} has no badge colour`);
    assert.ok(['neutral', 'busy', 'ok', 'warn', 'error'].includes(info.tone));
  }
});

test('statusInfo falls back rather than returning undefined', () => {
  const unknown = HUEN.statusInfo('nonsense');
  const idle = HUEN.statusInfo(HUEN.STATUS.IDLE);
  assert.strictEqual(unknown.label, idle.label);
  assert.strictEqual(unknown.badge, idle.badge);
  assert.strictEqual(unknown.tone, idle.tone);
});

test('t() falls back to the English text and substitutes placeholders', () => {
  // No chrome.i18n in the sandbox, so every call takes the fallback path.
  assert.strictEqual(HUEN.t('nope', 'Plain text'), 'Plain text');
  assert.strictEqual(HUEN.t('nope', 'From $1 to $2', ['German', 'English']),
    'From German to English');
  assert.strictEqual(HUEN.t('nope', 'One $1', 'thing'), 'One thing');
  // A key with no fallback is better than an empty string.
  assert.strictEqual(HUEN.t('someKey'), 'someKey');
});

test('only unrecoverable engine failures are fatal', () => {
  assert.ok(HUEN.isFatalCode(HUEN.ERR.NEEDS_GESTURE));
  assert.ok(HUEN.isFatalCode(HUEN.ERR.UNSUPPORTED));
  assert.ok(HUEN.isFatalCode(HUEN.ERR.PAIR_UNSUPPORTED));
  // One string the model choked on must not abandon the rest of the page.
  assert.ok(!HUEN.isFatalCode(HUEN.ERR.CREATE_FAILED));
  assert.ok(!HUEN.isFatalCode(undefined));
});

/* ---------- chunking long text ---------- */

test('short text is not chunked', () => {
  assert.deepStrictEqual(Array.from(HUEN.engine.chunk('Rövid mondat.')), ['Rövid mondat.']);
});

test('long text is cut at sentence boundaries and loses nothing', () => {
  const sentence = 'Ez egy teljesen átlagos magyar mondat a szövegben. ';
  const text = sentence.repeat(120); // comfortably over the per-call budget
  const parts = Array.from(HUEN.engine.chunk(text));

  assert.ok(parts.length > 1, 'expected the text to be split');
  assert.strictEqual(parts.join(''), text, 'chunking must be lossless');
  for (const part of parts) {
    assert.ok(part.length <= HUEN.engine.MAX_CHUNK,
      `chunk of ${part.length} exceeds the ${HUEN.engine.MAX_CHUNK} budget`);
  }
  // All but the last should end on a sentence break rather than mid-word.
  for (const part of parts.slice(0, -1)) {
    assert.match(part, /[.!?]\s*$/);
  }
});

test('a single unbroken run is still cut rather than refused', () => {
  const parts = Array.from(HUEN.engine.chunk('a'.repeat(5000)));
  assert.strictEqual(parts.join('').length, 5000);
  for (const part of parts) assert.ok(part.length <= HUEN.engine.MAX_CHUNK);
});

/* ---------- the glossary ---------- */

const glossary = () => HUEN.glossary.create(['Ügyfélkapu', 'NAV', 'Telex', 'C++']);

test('a phrase that is nothing but a glossary term is recognised', () => {
  const g = glossary();
  assert.ok(g.isExactTerm('Ügyfélkapu'));
  assert.ok(g.isExactTerm('  nav  '), 'matching ignores case and surrounding space');
  assert.ok(!g.isExactTerm('Ügyfélkapu Plusz'));
  assert.ok(!g.isExactTerm(''));
});

test('terms inside a sentence are shielded and put back', () => {
  const g = glossary();
  const { text, found } = g.protect('Lépjen be az Ügyfélkapu felületén a NAV oldalán.');

  assert.ok(!text.includes('Ügyfélkapu'), 'the term must not reach the model');
  assert.strictEqual(found.length, 2);

  // What a model plausibly returns, placeholders intact.
  const out = 'Log in through the {{G0}} interface on the {{G1}} site.';
  assert.strictEqual(HUEN.glossary.restore(out, found),
    'Log in through the Ügyfélkapu interface on the NAV site.');
});

test('a lost placeholder is reported rather than papered over', () => {
  const g = glossary();
  const { found } = g.protect('A NAV oldalán.');
  // A marker left in the page would look like a bug to the reader, so the
  // caller has to know to retranslate without protection.
  assert.strictEqual(HUEN.glossary.restore('On the site.', found), null);
  assert.strictEqual(HUEN.glossary.restore('On {{G0}} and {{G0}}.', found), null);
  assert.strictEqual(HUEN.glossary.restore('On {{G7}}.', found), null);
});

test('restore is a no-op when nothing was shielded', () => {
  assert.strictEqual(HUEN.glossary.restore('Plain output', []), 'Plain output');
});

test('a term only matches on word boundaries', () => {
  const g = HUEN.glossary.create(['NAV']);
  const { found } = g.protect('A NAVIGÁCIÓ nem a NAV.');
  assert.strictEqual(found.length, 1, 'NAVIGÁCIÓ must not match NAV');
});

test('punctuation-bearing terms still match', () => {
  const g = glossary();
  const { found } = g.protect('A C++ nyelvről.');
  assert.strictEqual(found.length, 1);
});

test('longer terms win over shorter ones they contain', () => {
  const g = HUEN.glossary.create(['Ügyfélkapu', 'Ügyfélkapu Plusz']);
  const { found } = g.protect('Az Ügyfélkapu Plusz szolgáltatás.');
  assert.deepStrictEqual(Array.from(found), ['Ügyfélkapu Plusz']);
});

test('the compiled list drops blanks and duplicates, longest first', () => {
  const list = Array.from(HUEN.glossary.compile(['NAV', '', '  nav  ', 'Ügyfélkapu']));
  assert.deepStrictEqual(list, ['Ügyfélkapu', 'NAV']);
});

/* ---------- language codes ---------- */

test('a detector tag is reduced to a code the Translator takes', () => {
  assert.strictEqual(HUEN.languages.base('pt-BR'), 'pt');
  assert.strictEqual(HUEN.languages.base('EN-us'), 'en');
  assert.strictEqual(HUEN.languages.base('zh-Hant-TW'), 'zh-Hant');
  assert.strictEqual(HUEN.languages.base('zh-Hans'), 'zh');
  assert.strictEqual(HUEN.languages.base(''), '');
});

test('language names are available for the codes on offer', () => {
  assert.strictEqual(HUEN.languages.nameOf('hu'), 'Hungarian');
  assert.strictEqual(HUEN.languages.nameOf('de-AT'), 'German');
  assert.ok(HUEN.languages.isKnown('hu'));
  assert.ok(!HUEN.languages.isKnown('xx'));
  // An unknown code is still printable rather than "undefined".
  assert.strictEqual(HUEN.languages.nameOf('xx'), 'xx');
});

test('the menu order is by name, and every code has one', () => {
  const codes = Array.from(HUEN.languages.CODES);
  assert.strictEqual(codes.length, Object.keys(HUEN.languages.NAMES).length);
  const names = codes.map((c) => HUEN.languages.NAMES[c]);
  assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
});

/* ---------- the new settings ---------- */

test('glossary terms keep their case but lose blanks and duplicates', () => {
  const s = HUEN.normalizeSettings({ glossary: ['NAV', ' NAV ', '', 'Ügyfélkapu'] });
  assert.deepStrictEqual(Array.from(s.glossary), ['NAV', 'Ügyfélkapu']);
});

test('autoDetectSource is on by default and coerced to a boolean', () => {
  assert.strictEqual(HUEN.normalizeSettings({}).autoDetectSource, true);
  assert.strictEqual(HUEN.normalizeSettings({ autoDetectSource: 0 }).autoDetectSource, false);
});

/* ---------- cache keys ---------- */

test('a glossary salt separates otherwise identical cache entries', () => {
  // A translation made with the glossary applied is not interchangeable with
  // one made without it, so the two must not share a key.
  const plain = HUEN.hash.cacheKey('Kapcsolat', 'hu', 'en');
  const salted = HUEN.hash.cacheKey('Kapcsolat', 'hu', 'en', 'g3');
  assert.notStrictEqual(plain, salted);
  assert.strictEqual(salted, HUEN.hash.cacheKey('Kapcsolat', 'hu', 'en', 'g3'));
});

test('the salt also separates long, hashed keys', () => {
  const long = 'a'.repeat(400);
  assert.notStrictEqual(
    HUEN.hash.cacheKey(long, 'hu', 'en'),
    HUEN.hash.cacheKey(long, 'hu', 'en', 'g2'));
});

/* ---------- the second marker syntax ---------- */

test('each marker syntax round-trips on its own', () => {
  const texts = ['A', 'kutya', 'fut a kertben'];
  for (let style = 0; style < HUEN.segmenter.STYLES.length; style++) {
    const joined = HUEN.segmenter.buildJoined(texts, style);
    assert.deepStrictEqual(
      Array.from(HUEN.segmenter.splitJoined(joined, 3, style)), texts,
      `style ${style} did not round-trip`);
  }
});

test('the bracket syntax parses a realistic translation', () => {
  assert.deepStrictEqual(
    Array.from(HUEN.segmenter.splitJoined('[[1]] The [[2]] dog [[3]] runs', 3, 1)),
    ['The', 'dog', 'runs']);
});

test('a syntax does not accept the other one output', () => {
  // Reading braces with the bracket parser must fail rather than silently
  // returning one giant part, which would put the whole sentence in one node.
  assert.strictEqual(HUEN.segmenter.splitJoined('{1} The {2} dog', 2, 1), null);
  assert.strictEqual(HUEN.segmenter.splitJoined('[[1]] The [[2]] dog', 2, 0), null);
});

test('an out-of-range style falls back to the first', () => {
  const joined = HUEN.segmenter.buildJoined(['egy', 'kettő'], 99);
  assert.ok(joined.startsWith('{1}'));
});

test('a glossary fingerprint changes when the terms change', () => {
  // Counting terms is not enough: swapping one for another keeps the count.
  const a = HUEN.glossary.create(['NAV', 'Telex']).fingerprint;
  const b = HUEN.glossary.create(['NAV', 'Index']).fingerprint;
  const c = HUEN.glossary.create(['Telex', 'NAV']).fingerprint;
  assert.notStrictEqual(a, b, 'different terms must not share cached output');
  assert.strictEqual(a, c, 'the same terms in another order are the same glossary');
  assert.strictEqual(HUEN.glossary.create([]).fingerprint, '',
    'no glossary means no salt, so plain entries stay reusable');
});

/* ---------- telling the user why there is no translator ---------- */

/* browser.describe() reads navigator, which the sandbox does not have, so each
   case installs one. The user agents below are real: every Chromium fork
   claims to be Chrome on purpose, which is exactly why the user agent alone
   cannot answer "which browser is this?". */
const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 OPR/142.0.0.0',
  oldChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

function describeAs(userAgent, isBrave) {
  const navigator = { userAgent };
  if (isBrave !== undefined) navigator.brave = { isBrave: async () => isBrave };
  SANDBOX.navigator = navigator;
  return HUEN.browser.describe();
}

test('Brave is identified despite claiming to be Chrome', async () => {
  // This is the case that sent a real user to the issue tracker: the user
  // agent says Chrome 156, so version checks pass and the API is still absent.
  const info = await describeAs(UA.chrome, true);
  assert.strictEqual(info.name, 'Brave');
  assert.ok(info.isOtherChromium, 'Brave is not Chrome and not Edge');
  assert.ok(!info.tooOld, 'the Chromium version is current; age is not the problem');
});

test('Chrome, Edge and Opera are told apart', async () => {
  assert.strictEqual((await describeAs(UA.chrome, false)).name, 'Chrome');
  assert.strictEqual((await describeAs(UA.edge, false)).name, 'Edge');
  assert.strictEqual((await describeAs(UA.opera, false)).name, 'Opera');
});

test('a browser with no isBrave hook is not mistaken for Brave', async () => {
  const info = await describeAs(UA.chrome);
  assert.strictEqual(info.name, 'Chrome');
  assert.ok(info.isChrome);
  assert.ok(!info.isOtherChromium);
});

test('a Chrome older than 138 is flagged as too old', async () => {
  const info = await describeAs(UA.oldChrome, false);
  assert.strictEqual(info.name, 'Chrome');
  assert.ok(info.tooOld);
  assert.strictEqual(info.major, 130);
});

test('a current Chrome is not flagged as too old', async () => {
  assert.ok(!(await describeAs(UA.chrome, false)).tooOld);
});

test('Edge is versioned by its own number, not Chromium’s', async () => {
  const info = await describeAs(UA.edge, false);
  assert.strictEqual(info.version, '156.0.0.0');
  assert.ok(!info.tooOld);
});

test('the explanation names the browser and matches the reason', () => {
  const t = (key, fallback, subs) => HUEN.t(key, fallback, subs);

  const fork = HUEN.browser.explainMissingApi(
    { name: 'Brave', version: '156', isOtherChromium: true, tooOld: false }, t);
  assert.match(fork, /^Brave does not provide/);

  const old = HUEN.browser.explainMissingApi(
    { name: 'Chrome', version: '130', isOtherChromium: false, tooOld: true }, t);
  assert.match(old, /Chrome 130/);
  assert.match(old, /too old/);

  const puzzling = HUEN.browser.explainMissingApi(
    { name: 'Chrome', version: '156', isOtherChromium: false, tooOld: false }, t);
  assert.match(puzzling, /chrome:\/\/flags/);

  // Whatever the case, the reader is told which browser they are in.
  for (const text of [fork, old, puzzling]) {
    assert.ok(!text.includes('$1'), 'a placeholder was left unsubstituted');
    assert.ok(!text.includes('$2'), 'a placeholder was left unsubstituted');
  }
});
