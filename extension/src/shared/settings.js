/* The settings schema, and the only place that knows how to read one safely.

   Every context loads this: a value that arrives from storage, from an older
   version of the extension, or from a hand-edited options page goes through
   `normalize()` before anything reads it, so no consumer needs its own
   defensive checks. */
(function (HUEN) {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    // auto       - translate any page that looks Hungarian
    // allowlist  - translate only on hosts in `allowlist`
    // manual     - never translate until asked
    mode: 'auto',
    allowlist: [],
    denylist: [],
    sourceLanguage: 'hu',
    targetLanguage: 'en',
    /* With this on, the source language is whatever the page turns out to be
       written in, and `sourceLanguage` is only the fallback for when detection
       cannot decide. Off, the extension only ever looks for `sourceLanguage`. */
    autoDetectSource: true,
    /* Terms to leave exactly as they are; see shared/glossary.js. */
    glossary: [],
    translateAttributes: true,
    translateTitle: true,
    showOriginalOnHover: true,
    cacheEnabled: true,
    // Minimum "looks Hungarian" score for the page-level check.
    minScore: 0.06,
    // Cap on stored cache entries; oldest are pruned first.
    cacheLimit: 20000,
  };

  const MODES = ['auto', 'allowlist', 'manual'];
  const SETTINGS_KEY = 'settings';

  const LIMITS = {
    minScore: { min: 0, max: 1 },
    cacheLimit: { min: 500, max: 200000 },
  };

  function clampNumber(value, fallback, bounds) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, n));
  }

  /* Strip the parts of a hostname that users never mean to distinguish. */
  function normalizeHost(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/^www\./, '');
  }

  function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of value) {
      const host = normalizeHost(entry);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push(host);
    }
    return out;
  }

  /* Glossary terms keep their case — "NAV" and "nav" are not the same thing to
     a reader — but duplicates and blanks go. */
  function normalizeTerms(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of value) {
      const term = String(entry == null ? '' : entry).trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
    return out;
  }

  function normalize(raw) {
    const out = Object.assign({}, DEFAULTS, raw || {});
    out.enabled = out.enabled !== false;
    out.allowlist = normalizeList(out.allowlist);
    out.denylist = normalizeList(out.denylist);
    out.glossary = normalizeTerms(out.glossary);
    if (MODES.indexOf(out.mode) === -1) out.mode = DEFAULTS.mode;
    out.minScore = clampNumber(out.minScore, DEFAULTS.minScore, LIMITS.minScore);
    out.cacheLimit = Math.round(
      clampNumber(out.cacheLimit, DEFAULTS.cacheLimit, LIMITS.cacheLimit));
    for (const key of ['translateAttributes', 'translateTitle',
      'showOriginalOnHover', 'cacheEnabled', 'autoDetectSource']) {
      out[key] = !!out[key];
    }
    out.sourceLanguage = String(out.sourceLanguage || DEFAULTS.sourceLanguage);
    out.targetLanguage = String(out.targetLanguage || DEFAULTS.targetLanguage);
    return out;
  }

  /* A list entry matches the host itself and any subdomain of it. It must not
     match a host that merely ends with the same letters, so the dot is part of
     the comparison: "telex.hu" matches "static.telex.hu" but not
     "nottelex.hu", and never "telex.hu.evil.com". */
  function hostMatches(list, hostname) {
    if (!Array.isArray(list) || !list.length) return false;
    const host = normalizeHost(hostname);
    if (!host) return false;
    for (const entry of list) {
      const pattern = normalizeHost(entry);
      if (!pattern) continue;
      if (host === pattern || host.endsWith('.' + pattern)) return true;
    }
    return false;
  }

  /* Add or remove one host from a list, without duplicating it. */
  function withHost(list, hostname, present) {
    const host = normalizeHost(hostname);
    const rest = normalizeList(list).filter(function (entry) { return entry !== host; });
    if (present && host) rest.push(host);
    return rest;
  }

  /* Should this frame translate without being asked? */
  function shouldAutoTranslate(settings, hostname) {
    if (!settings.enabled) return false;
    if (hostMatches(settings.denylist, hostname)) return false;
    if (settings.mode === 'manual') return false;
    if (settings.mode === 'allowlist') return hostMatches(settings.allowlist, hostname);
    return true;
  }

  HUEN.DEFAULTS = DEFAULTS;
  HUEN.MODES = MODES;
  HUEN.SETTINGS_KEY = SETTINGS_KEY;
  HUEN.normalizeSettings = normalize;
  HUEN.normalizeHost = normalizeHost;
  HUEN.hostMatches = hostMatches;
  HUEN.withHost = withHost;
  HUEN.shouldAutoTranslate = shouldAutoTranslate;
})(globalThis.HUEN);
