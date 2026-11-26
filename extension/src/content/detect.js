/* "What language is this page in, and is it worth translating?"

   Getting this wrong is the most visible failure mode in either direction: a
   foreign page left untouched is annoying, and a page already in the target
   language run through the translator is worse.

   Three signals, cheapest first:

     1. the document's own `lang` attribute, when it says anything useful
     2. a word/diacritic heuristic (free, but it only knows Hungarian)
     3. Chrome's on-device LanguageDetector, once, on a sample

   The Hungarian heuristic is kept as the fast path because it costs nothing
   and this extension exists for Hungarian pages. The detector generalises it
   to everything else, and is only reached when the cheap signals cannot
   decide. */
(function (HUEN) {
  'use strict';

  const { lang, tags, languages } = HUEN;

  const SAMPLE_CHARS = 2000;
  const DETECTOR_CHARS = 1000;
  const MIN_SAMPLE = 40;
  const DETECTOR_CONFIDENCE = 0.3;
  /* Above this score, an explicit lang="en" is treated as wrong rather than
     authoritative. Plenty of Hungarian sites never change the boilerplate. */
  const OVERRIDE_DECLARED = 0.25;

  /* Walk text nodes for a sample of what the reader actually sees. TreeWalker
     rather than textContent so script and style bodies stay out, and no layout
     is flushed: this runs before anything is on screen. */
  function samplePageText(limit) {
    const max = limit || SAMPLE_CHARS;
    const root = document.body || document.documentElement;
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const parts = [];
    let length = 0;
    let node;
    while ((node = walker.nextNode()) !== null) {
      const parent = node.parentElement;
      if (!parent || tags.SKIP.has(parent.tagName)) continue;
      const text = node.data.replace(/\s+/g, ' ').trim();
      if (text.length < 3) continue;
      parts.push(text);
      length += text.length + 1;
      if (length >= max) break;
    }
    return parts.join(' ');
  }

  function verdict(fields) {
    return Object.assign({
      translate: false,
      source: '',
      score: 0,
      detected: null,
      reason: '',
    }, fields);
  }

  /* Resolves to { translate, source, score, detected, reason }.

     `source` is the language to translate *from*, which is no longer
     necessarily the one in settings. `reason` is carried through to the popup
     so the decision is inspectable rather than magic. */
  async function inspectPage(settings) {
    const target = languages.base(settings.targetLanguage);
    const configured = languages.base(settings.sourceLanguage);
    const auto = !!settings.autoDetectSource;
    const declaredRaw = document.documentElement.getAttribute('lang') || '';
    const declared = languages.base(declaredRaw);
    /* A document can declare anything, and plenty declare something the
       translator has no model for: "zxx" (the code for "no linguistic
       content", which reCAPTCHA and consent iframes use), "und", "mul",
       "x-default", or simply a typo. Taking such a code at face value and
       asking for a zxx-to-English translator fails hard on a frame that
       was never going to need translating, so an unrecognised code counts
       as no declaration at all and the other signals decide. */
    const declaredUsable = !!declared && languages.isKnown(declared);

    const sample = samplePageText(SAMPLE_CHARS);
    const score = sample ? lang.hungarianScore(sample) : 0;

    /* 1. The page says what it is. Believe it, unless it claims to be the
          target language and the text argues otherwise. */
    if (declaredUsable && declared !== target) {
      if (auto || declared === configured) {
        return verdict({
          translate: true,
          source: declared,
          score,
          reason: 'the page declares lang="' + declared + '"',
        });
      }
    }

    if (declaredUsable && declared === target && score < OVERRIDE_DECLARED) {
      return verdict({
        score,
        reason: 'the page declares lang="' + declared + '"',
      });
    }

    if (!sample || sample.length < MIN_SAMPLE) {
      return verdict({ score, reason: 'there is too little text to judge' });
    }

    /* 2. The free heuristic, which only knows Hungarian. */
    if (score >= settings.minScore && (configured === 'hu' || auto)) {
      return verdict({
        translate: true,
        source: 'hu',
        score,
        reason: 'the text scores ' + score.toFixed(2) + ' on the Hungarian check',
      });
    }

    /* 3. The detector model. Without auto-detection this is only ever asked to
          confirm the configured language; with it, the answer picks the pair. */
    const detected = await lang.detectWithModel(sample.slice(0, DETECTOR_CHARS));
    if (!detected) {
      return verdict({
        score,
        reason: 'the text scores only ' + score.toFixed(2) + ' on the Hungarian check',
      });
    }

    const found = languages.base(detected.language);
    const confident = detected.confidence > DETECTOR_CONFIDENCE;

    if (!confident) {
      return verdict({
        score,
        detected,
        reason: 'no language could be identified with any confidence',
      });
    }
    if (found === target) {
      return verdict({
        score,
        detected,
        reason: 'the page is already in ' + languages.nameOf(target),
      });
    }
    if (!auto && found !== configured) {
      return verdict({
        score,
        detected,
        reason: 'this reads as ' + languages.nameOf(found) + ', not ' +
          languages.nameOf(configured),
      });
    }
    if (!languages.isKnown(found)) {
      return verdict({
        score,
        detected,
        reason: languages.nameOf(found) + ' is not a language Chrome can translate',
      });
    }

    return verdict({
      translate: true,
      source: found,
      score,
      detected,
      reason: 'Chrome’s language detector reads this as ' + languages.nameOf(found),
    });
  }

  HUEN.detect = { inspectPage, samplePageText };
})(globalThis.HUEN);
