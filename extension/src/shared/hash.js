/* Cache keys. Short strings are used verbatim (no collision risk at all);
   long ones fall back to a 32-bit FNV-1a hash plus the length, which makes an
   accidental collision vanishingly unlikely. */
(function (HUEN) {
  'use strict';

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  const INLINE_MAX = 180;

  /* `salt` separates translations that are not interchangeable even though the
     source text is identical — currently, whether a glossary was applied. */
  function cacheKey(text, source, target, salt) {
    const pair = source + '>' + target + (salt ? '+' + salt : '');
    if (text.length <= INLINE_MAX) return pair + '|' + text;
    return pair + '#' + text.length + '.' + fnv1a(text);
  }

  HUEN.hash = { cacheKey, fnv1a };
})(globalThis.HUEN);
