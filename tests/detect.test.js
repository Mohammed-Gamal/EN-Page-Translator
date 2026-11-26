/* Tests for the page-language decision in content/detect.js.

   This is the module that decides whether to translate at all and which model
   to ask for, so getting it wrong is visible to the user in both directions:
   a foreign page left alone, or a hard error on a page that was fine.

   detect.js reads `document`, `NodeFilter` and `navigator`, so this file
   supplies the smallest versions of those that it actually touches. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'extension', 'src');

/* ---------- the smallest document detect.js can work with ---------- */

function makeDocument(options) {
  const text = options.text || '';
  const lang = options.lang;

  // samplePageText walks text nodes under body and skips those whose parent is
  // a skipped tag. One paragraph of text is enough to exercise that.
  const paragraph = { nodeType: 1, tagName: 'P' };
  const textNode = { nodeType: 3, data: text, parentElement: paragraph };
  const body = { nodeType: 1, tagName: 'BODY' };

  return {
    documentElement: {
      getAttribute(name) {
        if (name !== 'lang') return null;
        return lang === undefined ? null : lang;
      },
    },
    body,
    createTreeWalker() {
      let handed = false;
      return {
        nextNode() {
          if (handed || !text) return null;
          handed = true;
          return textNode;
        },
      };
    },
  };
}

function load(options) {
  const sandbox = {
    console,
    NodeFilter: { SHOW_TEXT: 4 },
    navigator: { userAgent: 'node' },
  };
  sandbox.globalThis = sandbox;
  sandbox.document = makeDocument(options);
  // detect.js only reaches the detector when the cheap signals cannot decide;
  // `detected` controls what it finds when it does.
  if (options.detected !== undefined) {
    sandbox.LanguageDetector = {
      availability: async () => 'available',
      create: async () => ({
        detect: async () => (options.detected ? [options.detected] : []),
        destroy() {},
      }),
    };
  }
  vm.createContext(sandbox);
  for (const file of [
    'shared/namespace.js', 'shared/protocol.js', 'shared/settings.js',
    'shared/languages.js', 'shared/lang.js', 'content/tags.js',
    'content/detect.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'),
      sandbox, { filename: file });
  }
  return sandbox.HUEN;
}

function inspect(options, overrides) {
  const HUEN = load(options);
  const settings = HUEN.normalizeSettings(overrides || {});
  return HUEN.detect.inspectPage(settings);
}

const HUNGARIAN = 'Az oldal használatához kérjük, fogadja el a feltételeket. ' +
  'Bejelentkezés után megtekintheti a számláit és a befizetéseit.';
const ENGLISH = 'Please accept the terms and conditions to continue using ' +
  'this site. Log in to view your invoices and payments.';

/* ---------- junk language codes ---------- */

/* Regression: a frame declaring lang="zxx" — the ISO code for "no linguistic
   content", which reCAPTCHA and cookie-consent iframes really do use — was
   taken at face value. The extension then asked the browser for a zxx-to-
   English translator and reported "This browser has no built-in translator
   for zxx → English", on a page whose main document was ordinary Hungarian. */
for (const code of ['zxx', 'und', 'mul', 'x-default', 'qq', '']) {
  test(`lang="${code}" is not trusted as a source language`, async () => {
    const verdict = await inspect({ lang: code, text: HUNGARIAN });
    assert.notStrictEqual(verdict.source, code,
      `"${code}" must never be handed to the translator`);
    if (verdict.translate) {
      assert.ok(HUEN_KNOWN(verdict.source),
        `translating with source "${verdict.source}", which has no model`);
    }
  });
}

const HUEN_KNOWN = (code) => load({ text: '' }).languages.isKnown(code);

test('a junk lang falls through to the text, which still reads as Hungarian', async () => {
  const verdict = await inspect({ lang: 'zxx', text: HUNGARIAN });
  assert.ok(verdict.translate, 'the page is Hungarian and should be translated');
  assert.strictEqual(verdict.source, 'hu');
});

test('a junk lang on a frame with no text translates nothing', async () => {
  const verdict = await inspect({ lang: 'zxx', text: '' });
  assert.ok(!verdict.translate);
  assert.match(verdict.reason, /too little text/);
});

/* ---------- ordinary declarations still work ---------- */

test('lang="hu-HU" is reduced to hu and trusted', async () => {
  const verdict = await inspect({ lang: 'hu-HU', text: HUNGARIAN });
  assert.ok(verdict.translate);
  assert.strictEqual(verdict.source, 'hu');
});

test('lang="de" is trusted when detection is on', async () => {
  const verdict = await inspect({ lang: 'de', text: 'Guten Tag, das ist ein Test.' });
  assert.ok(verdict.translate);
  assert.strictEqual(verdict.source, 'de');
});

test('lang="de" is refused when detection is off and the source is hu', async () => {
  const verdict = await inspect(
    { lang: 'de', text: ENGLISH, detected: null },
    { autoDetectSource: false });
  assert.ok(!verdict.translate);
});

test('a page already in the target language is left alone', async () => {
  const verdict = await inspect({ lang: 'en', text: ENGLISH });
  assert.ok(!verdict.translate);
  assert.match(verdict.reason, /lang="en"/);
});

test('lang="en" is overridden when the text is plainly Hungarian', async () => {
  // Boilerplate nobody updated. The text wins.
  const verdict = await inspect({ lang: 'en', text: HUNGARIAN });
  assert.ok(verdict.translate);
  assert.strictEqual(verdict.source, 'hu');
});

/* ---------- the detector ---------- */

test('the detector is not trusted with a code that has no model', async () => {
  const verdict = await inspect({
    lang: undefined,
    text: ENGLISH,
    detected: { detectedLanguage: 'zxx', confidence: 0.99 },
  });
  assert.ok(!verdict.translate);
  assert.strictEqual(verdict.source, '');
});

test('a confident detection of a real language is used', async () => {
  const verdict = await inspect({
    lang: undefined,
    text: 'Dies ist ein deutscher Satz mit genug Text darin.',
    detected: { detectedLanguage: 'de', confidence: 0.95 },
  });
  assert.ok(verdict.translate);
  assert.strictEqual(verdict.source, 'de');
});

test('a low-confidence detection is refused', async () => {
  const verdict = await inspect({
    lang: undefined,
    text: ENGLISH,
    detected: { detectedLanguage: 'de', confidence: 0.1 },
  });
  assert.ok(!verdict.translate);
  assert.match(verdict.reason, /confidence/);
});

test('a detection of the target language is refused', async () => {
  const verdict = await inspect({
    lang: undefined,
    text: ENGLISH,
    detected: { detectedLanguage: 'en', confidence: 0.99 },
  });
  assert.ok(!verdict.translate);
  assert.match(verdict.reason, /already in English/);
});

test('whatever it decides, the source is always a translatable code', async () => {
  const cases = [
    { lang: 'zxx', text: HUNGARIAN },
    { lang: 'und', text: ENGLISH, detected: { detectedLanguage: 'zxx', confidence: 0.9 } },
    { lang: 'x-default', text: '' },
    { lang: 'hu-HU', text: HUNGARIAN },
    { lang: undefined, text: ENGLISH, detected: { detectedLanguage: 'fr', confidence: 0.8 } },
  ];
  for (const options of cases) {
    const verdict = await inspect(options);
    if (!verdict.translate) continue;
    assert.ok(HUEN_KNOWN(verdict.source),
      `lang=${options.lang} produced untranslatable source "${verdict.source}"`);
  }
});
