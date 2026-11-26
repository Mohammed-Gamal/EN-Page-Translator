/* The vocabulary every context shares: message names, the page status enum,
   and promise-shaped wrappers around `chrome.runtime` / `chrome.tabs`.

   Before this file existed, each of the five contexts (content script, popup,
   options page, service worker, offscreen document) carried its own copy of a
   callback-to-promise helper and its own hand-typed message strings. One typo
   in one of them failed silently, because an unhandled message simply never
   gets a reply.

   Loaded as a classic script everywhere, including via importScripts() in the
   service worker, so: no modules, no `window`. */
(function (HUEN) {
  'use strict';

  /* ---------- message names ---------- */

  const MSG = {
    // content script / UI -> service worker
    GET_SETTINGS: 'huen:settings:get',
    SET_SETTINGS: 'huen:settings:set',
    CACHE_GET: 'huen:cache:get',
    CACHE_PUT: 'huen:cache:put',
    CACHE_STATS: 'huen:cache:stats',
    CACHE_CLEAR: 'huen:cache:clear',
    TRANSLATE: 'huen:translate',
    ENSURE_MODEL: 'huen:model:ensure',
    GET_ENGINE: 'huen:engine:get',
    TEST_CLOUD: 'huen:cloud:test',
    REPORT_STATUS: 'huen:status:report',

    // service worker / UI -> content script
    GET_STATE: 'huen:state:get',
    TRANSLATE_NOW: 'huen:page:translate',
    TRANSLATE_SELECTION: 'huen:page:translate-selection',
    RESTORE: 'huen:page:restore',
    TOGGLE: 'huen:page:toggle',
    SETTINGS_CHANGED: 'huen:settings:changed',

    // service worker -> offscreen document
    OFFSCREEN_TRANSLATE: 'huen:offscreen:translate',
    OFFSCREEN_ENSURE: 'huen:offscreen:ensure',
  };

  /* ---------- translated strings ---------- */

  /* chrome.i18n with an English fallback baked in at the call site.

     The fallback is not just belt and braces: the tests load these modules in
     a bare sandbox with no `chrome` at all, and keeping the English text next
     to the key makes the code readable without opening messages.json. When
     chrome.i18n answers it has already substituted $1, $2 …; the replace below
     only does anything on the fallback path. */
  function t(key, fallback, subs) {
    let text = '';
    try {
      if (globalThis.chrome && chrome.i18n && chrome.i18n.getMessage) {
        text = chrome.i18n.getMessage(key, subs) || '';
      }
    } catch (_) { /* no extension context, e.g. a test sandbox */ }
    if (!text) text = fallback === undefined ? key : fallback;
    if (subs === undefined) return text;
    const list = Array.isArray(subs) ? subs : [subs];
    return text.replace(/\$(\d)/g, function (whole, digit) {
      const value = list[Number(digit) - 1];
      return value === undefined ? whole : String(value);
    });
  }

  /* ---------- page status ---------- */

  /* One enum, one set of human labels, one badge spec. The popup reads the
     labels and the service worker reads the badges, so a new status cannot be
     added to one and forgotten in the other. */
  const STATUS = {
    IDLE: 'idle',
    CHECKING: 'checking',
    SKIPPED: 'skipped',
    NEEDS_DOWNLOAD: 'needs-download',
    DOWNLOADING: 'downloading',
    TRANSLATING: 'translating',
    DONE: 'done',
    ERROR: 'error',
  };

  const STATUS_INFO = {
    idle: { key: 'statusIdle', label: 'Idle on this page', tone: 'neutral', badge: '', badgeColor: '#6f6a60' },
    checking: { key: 'statusChecking', label: 'Looking at this page', tone: 'neutral', badge: '', badgeColor: '#6f6a60' },
    skipped: { key: 'statusSkipped', label: 'Left in its own language', tone: 'neutral', badge: '', badgeColor: '#6f6a60' },
    'needs-download': { key: 'statusNeedsDownload', label: 'Needs the language model', tone: 'warn', badge: '!', badgeColor: '#b7791f' },
    downloading: { key: 'statusDownloading', label: 'Fetching the language model', tone: 'busy', badge: '↓', badgeColor: '#2f6b4f' },
    translating: { key: 'statusTranslating', label: 'Translating', tone: 'busy', badge: '…', badgeColor: '#2f6b4f' },
    done: { key: 'statusDone', label: 'Translated', tone: 'ok', badge: 'EN', badgeColor: '#2f6b4f' },
    error: { key: 'statusError', label: 'Something went wrong', tone: 'error', badge: '!', badgeColor: '#b3261e' },
  };

  /* Returns the spec with `label` already localised, so neither the popup nor
     the service worker has to know that i18n is involved. */
  function statusInfo(status) {
    const info = STATUS_INFO[status] || STATUS_INFO.idle;
    return Object.assign({}, info, { label: t(info.key, info.label) });
  }

  /* ---------- error codes raised by the engine ---------- */

  const ERR = {
    UNSUPPORTED: 'UNSUPPORTED',
    NEEDS_GESTURE: 'NEEDS_GESTURE',
    PAIR_UNSUPPORTED: 'PAIR_UNSUPPORTED',
    CREATE_FAILED: 'CREATE_FAILED',
    /* Cloud provider failures. AUTH and QUOTA are worth stopping for —
       no other string will fare better — while a transient network or
       rate-limit problem is not. */
    CLOUD_AUTH: 'CLOUD_AUTH',
    CLOUD_QUOTA: 'CLOUD_QUOTA',
    CLOUD_FAILED: 'CLOUD_FAILED',
    CLOUD_UNCONFIGURED: 'CLOUD_UNCONFIGURED',
  };

  /* A failure the caller cannot recover from by retrying a different string. */
  const FATAL_CODES = new Set([
    ERR.UNSUPPORTED, ERR.NEEDS_GESTURE, ERR.PAIR_UNSUPPORTED,
    ERR.CLOUD_AUTH, ERR.CLOUD_QUOTA, ERR.CLOUD_UNCONFIGURED,
  ]);

  function isFatalCode(code) {
    return FATAL_CODES.has(code);
  }

  /* ---------- transport ---------- */

  /* Resolves to null instead of rejecting when nobody is listening. Every
     caller here treats "no answer" and "error answer" the same way, and
     chrome.runtime.lastError must be read inside the callback or Chrome logs an
     unchecked-error warning. */
  function sendMessage(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          void chrome.runtime.lastError;
          resolve(response === undefined ? null : response);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /* Same contract, aimed at one tab. A tab with no content script (chrome://,
     the web store, a PDF viewer) resolves to null rather than throwing. */
  function sendToTab(tabId, message, options) {
    return new Promise(function (resolve) {
      if (!tabId || typeof chrome.tabs === 'undefined') return resolve(null);
      try {
        chrome.tabs.sendMessage(tabId, message, options || {}, function (response) {
          void chrome.runtime.lastError;
          resolve(response === undefined ? null : response);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /* Register async handlers without repeating the `return true` dance that
     keeps the message channel open. Each handler gets (message, sender) and
     may return a value or a promise; `undefined` means "not mine". */
  function serve(handlers) {
    chrome.runtime.onMessage.addListener(function (message, sender, respond) {
      if (!message || typeof message.type !== 'string') return false;
      const handler = handlers[message.type];
      if (!handler) return false;
      let result;
      try {
        result = handler(message, sender);
      } catch (err) {
        respond({ ok: false, error: String((err && err.message) || err) });
        return true;
      }
      if (result && typeof result.then === 'function') {
        result.then(
          function (value) { respond(value === undefined ? { ok: true } : value); },
          function (err) { respond({ ok: false, error: String((err && err.message) || err) }); }
        );
        return true;
      }
      respond(result === undefined ? { ok: true } : result);
      return true;
    });
  }

  HUEN.MSG = MSG;
  HUEN.t = t;
  HUEN.STATUS = STATUS;
  HUEN.STATUS_INFO = STATUS_INFO;
  HUEN.statusInfo = statusInfo;
  HUEN.ERR = ERR;
  HUEN.isFatalCode = isFatalCode;
  /* Pass as sendToTab's options to reach only the main document.

     Without it the message goes to every frame and the first reply wins,
     which for a question like "what is this page's status?" means a
     reCAPTCHA or cookie-consent iframe can answer on the page's behalf. */
  const TOP_FRAME = { frameId: 0 };

  HUEN.sendMessage = sendMessage;
  HUEN.sendToTab = sendToTab;
  HUEN.TOP_FRAME = TOP_FRAME;
  HUEN.serve = serve;
})(globalThis.HUEN);
