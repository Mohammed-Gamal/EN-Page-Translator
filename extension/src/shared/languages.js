/* The languages Chrome documents for its built-in Translator, and the names to
   show for them.

   The list is explicitly "subject to change", so nothing here decides what
   actually works: `engine.availability()` does. This exists so the options
   menus have something to list, and so the popup and the in-page prompt can say
   "German" instead of "de". */
(function (HUEN) {
  'use strict';

  const NAMES = {
    ar: 'Arabic', bn: 'Bengali', bg: 'Bulgarian', cs: 'Czech', da: 'Danish',
    de: 'German', el: 'Greek', en: 'English', es: 'Spanish', fi: 'Finnish',
    fr: 'French', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
    id: 'Indonesian', it: 'Italian', ja: 'Japanese', kn: 'Kannada',
    ko: 'Korean', lt: 'Lithuanian', mr: 'Marathi', nl: 'Dutch',
    no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian',
    ru: 'Russian', sk: 'Slovak', sl: 'Slovenian', sv: 'Swedish', ta: 'Tamil',
    te: 'Telugu', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian',
    vi: 'Vietnamese', zh: 'Chinese (Simplified)', 'zh-Hant': 'Chinese (Traditional)',
  };

  /* Codes sorted by the name shown, which is the order a menu wants. */
  const CODES = Object.keys(NAMES).sort(function (a, b) {
    return NAMES[a].localeCompare(NAMES[b]);
  });

  /* A detector returns BCP-47 tags like "pt-BR" or "zh-Hans"; the Translator
     takes the base code, bar the one script distinction it recognises. */
  function base(tag) {
    const code = String(tag || '').trim();
    if (!code) return '';
    if (/^zh-Hant/i.test(code)) return 'zh-Hant';
    return code.split('-')[0].toLowerCase();
  }

  function nameOf(tag) {
    const code = base(tag);
    return NAMES[code] || code || 'unknown';
  }

  function isKnown(tag) {
    return Object.prototype.hasOwnProperty.call(NAMES, base(tag));
  }

  HUEN.languages = { NAMES, CODES, base, nameOf, isKnown };
})(globalThis.HUEN);
