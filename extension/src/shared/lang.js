/* Hungarian detection and "is this worth translating?" heuristics.
   Deliberately cheap: this runs over every text segment on the page, so it must
   not allocate much. The expensive LanguageDetector model is used only once per
   page, on a sample, as a cross-check. */
(function (HUEN) {
  'use strict';

  // o-double-acute and u-double-acute are effectively unique to Hungarian.
  const HU_UNIQUE = /[\u0151\u0171\u0150\u0170]/;
  const HU_ACCENT = /[\u00e1\u00e9\u00ed\u00f3\u00f6\u00fa\u00fc\u0151\u0171\u00c1\u00c9\u00cd\u00d3\u00d6\u00da\u00dc\u0150\u0170]/;

  const HU_WORDS = new Set((
    'a az és is nem hogy egy van vannak meg csak már ez ezt ezek de mint vagy ha majd ' +
    'ki be fel le ne se el volt lesz lehet kell mert így még nagyon minden több kevés ' +
    'után előtt nélkül miatt szerint között alatt felett mellett illetve valamint ' +
    'további oldal oldalak kezdőlap bejelentkezés kijelentkezés regisztráció keresés ' +
    'részletek kapcsolat rólunk adatvédelmi feltételek hírek szolgáltatás szolgáltatások ' +
    'termék termékek ár árak forint ingyenes letöltés küldés mentés tovább vissza ' +
    'hétfő kedd szerda csütörtök péntek szombat vasárnap január február március ' +
    'április május június július augusztus szeptember október november december ' +
    'év hónap nap óra perc ma holnap tegnap most itt ott ahol amikor aki amely ' +
    'magyar magyarország budapest cím telefon email üzenet név jelszó'
  ).split(' '));

  const EN_WORDS = new Set((
    'the and or of to in is are was were be been being have has had do does did ' +
    'for with from this that these those you your we our they their it its on at ' +
    'by as not but if then than when where which who what how all any more most ' +
    'home login logout register search details contact about privacy terms news ' +
    'products price free download send save next back page english'
  ).split(' '));

  const WORD_RE = /[\p{L}\p{M}]+/gu;
  const HAS_LETTER = /[\p{L}]/u;

  function words(text) {
    return (text.toLowerCase().match(WORD_RE) || []);
  }

  /* Returns a score in [-1, 1]. Positive means "looks Hungarian",
     negative means "looks like it is already English". */
  function hungarianScore(text) {
    const w = words(text);
    if (!w.length) return 0;

    let hu = 0;
    let en = 0;
    for (const word of w) {
      if (HU_WORDS.has(word)) hu++;
      if (EN_WORDS.has(word)) en++;
    }

    let score = (hu - en) / w.length;
    if (HU_UNIQUE.test(text)) score += 0.45;
    else if (HU_ACCENT.test(text)) score += 0.2;

    // Hungarian is agglutinative: long words are a weak extra signal.
    const avgLen = w.reduce((s, x) => s + x.length, 0) / w.length;
    if (avgLen > 7) score += 0.08;

    return Math.max(-1, Math.min(1, score));
  }

  /* Text that should never be sent to the translator: no letters at all
     (numbers, prices, dates, punctuation, icon glyphs), bare URLs, emails,
     or a single short token with no Hungarian marker. */
  const URLISH = /^(?:https?:\/\/|www\.|mailto:|tel:)/i;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function isTranslatable(text) {
    const t = text.trim();
    if (t.length < 2) return false;
    if (!HAS_LETTER.test(t)) return false;
    if (URLISH.test(t) || EMAIL.test(t)) return false;

    // Require at least one real word. This drops prices ("1 234 Ft"), units,
    // codes and two-letter labels, which the translator would either pass
    // through unchanged or mangle.
    let longest = 0;
    const found = t.match(WORD_RE);
    if (!found) return false;
    for (const word of found) {
      if (word.length > longest) longest = word.length;
    }
    if (longest >= 3) return true;
    // Two-letter words still count when accented, e.g. "Fő".
    return longest >= 2 && HU_ACCENT.test(t);
  }

  /* Cross-check the page language with Chrome's on-device LanguageDetector.
     Returns { language, confidence } or null when the model is unavailable. */
  async function detectWithModel(sample) {
    try {
      if (!('LanguageDetector' in globalThis)) return null;
      const avail = await LanguageDetector.availability();
      if (avail !== 'available') return null;
      const detector = await LanguageDetector.create();
      const results = await detector.detect(sample);
      if (typeof detector.destroy === 'function') detector.destroy();
      if (!results || !results.length) return null;
      return { language: results[0].detectedLanguage, confidence: results[0].confidence };
    } catch (_) {
      return null;
    }
  }

  HUEN.lang = {
    hungarianScore,
    isTranslatable,
    detectWithModel,
  };
})(globalThis.HUEN);
