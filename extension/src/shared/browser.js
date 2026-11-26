/* Which browser is this, really?

   The point of this file is to answer "why is there no Translator API here?"
   with something the reader can act on. "Desktop Chrome 138+ required" is
   useless advice to someone already running Chromium 156 — the reason their
   browser lacks the API is that it is not Chrome.

   The user agent cannot tell you that. Brave, Opera and Vivaldi all present
   themselves as Chrome on purpose, so the UA string says `Chrome/156` in every
   one of them. Brave exposes `navigator.brave.isBrave()` — a promise, and the
   only reliable signal there is; the others leave a token in the UA. */
(function (HUEN) {
  'use strict';

  /* Chrome shipped the Translator API in 138, Edge in 148. */
  const MIN_CHROME = 138;
  const MIN_EDGE = 148;

  async function describe() {
    const ua = navigator.userAgent || '';
    const edgeVersion = (/\bEdg\/([\d.]+)/.exec(ua) || [])[1];
    const chromiumVersion = (/\bChrom(?:e|ium)\/([\d.]+)/.exec(ua) || [])[1];
    const major = Number(String(chromiumVersion || '').split('.')[0]) || 0;

    let brave = false;
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
        brave = await navigator.brave.isBrave();
      }
    } catch (_) { /* not Brave, or the check was blocked */ }

    let name = 'Chrome';
    let version = chromiumVersion || 'unknown';
    if (brave) {
      name = 'Brave';
    } else if (edgeVersion) {
      name = 'Edge';
      version = edgeVersion;
    } else if (/\bOPR\//.test(ua)) {
      name = 'Opera';
    } else if (/\bVivaldi\//.test(ua)) {
      name = 'Vivaldi';
    } else if (/\bChromium\//.test(ua) && !/\bChrome\//.test(ua)) {
      name = 'Chromium';
    }

    const isEdge = name === 'Edge';
    const isChrome = name === 'Chrome';
    return {
      name,
      version,
      major: isEdge ? (Number(String(edgeVersion).split('.')[0]) || 0) : major,
      isChrome,
      isEdge,
      /* A Chromium build that is neither Chrome nor Edge. The built-in AI
         stack is a Chrome feature, not a Chromium one, so these commonly ship
         without it however new they are. */
      isOtherChromium: !isChrome && !isEdge,
      tooOld: isEdge ? (Number(String(edgeVersion).split('.')[0]) || 0) < MIN_EDGE
        : (isChrome && major > 0 && major < MIN_CHROME),
    };
  }

  /* One sentence explaining why the API is missing here, given what we can
     work out about the browser. */
  function explainMissingApi(info, t) {
    if (info.isOtherChromium) {
      return t('unsupportedFork',
        '$1 does not provide the translator that is built into Chrome. This ' +
        'extension needs desktop Chrome 138 or later, or Edge 148 or later.',
        [info.name]);
    }
    if (info.tooOld) {
      return t('unsupportedOld',
        'This is $1 $2. The built-in translator arrived in Chrome 138 and ' +
        'Edge 148, so this version is too old.',
        [info.name, info.version]);
    }
    return t('unsupportedUnknown',
      '$1 $2 should have the built-in translator but is not offering it. ' +
      'Check the built-in AI flags at chrome://flags, and that the drive ' +
      'holding your browser profile has room for the model.',
      [info.name, info.version]);
  }

  HUEN.browser = { describe, explainMissingApi, MIN_CHROME, MIN_EDGE };
})(globalThis.HUEN);
