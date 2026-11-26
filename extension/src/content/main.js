/* Per-frame orchestration.

   The whole flow, in order:

     settings -> what language is this page? -> is a model on disk?
       -> if not, show a card asking for one click, because Chrome will only
          download a language model inside a user activation
       -> collect segments -> queue -> translate -> apply
       -> keep watching the DOM for whatever the page loads later

   Runs in every frame (all_frames in the manifest). Only the top frame draws
   UI or reports status, so a page with twelve ad iframes does not produce
   twelve prompts. */
(function (HUEN) {
  'use strict';

  if (HUEN.started) return;
  HUEN.started = true;

  const { engine, lang, languages, segmenter, applier, detect, overlay, tags,
    MSG, STATUS, ERR, sendMessage, serve, t } = HUEN;

  const OBSERVER_DEBOUNCE = 250;

  const isTopFrame = (function () {
    try { return window.top === window; } catch (_) { return false; }
  })();

  const state = {
    settings: HUEN.normalizeSettings({}),
    /* The language this page turned out to be in, which with auto-detection on
       is not necessarily the one in settings. Everything downstream — the
       model, the cache keys, the prompt wording — follows this, not the
       setting. */
    source: 'hu',
    active: false,
    /* True when only a selected passage was translated. The rest of the page
       is untouched, so the document language must not change and new content
       must not be picked up. */
    selectionOnly: false,
    queue: null,
    observer: null,
    glossary: null,
    status: STATUS.IDLE,
    message: '',
    downloadPct: 0,
    /* Which translator this frame is using, decided by the service worker
       from the settings and from whether the API exists here at all.
       'builtin' is the only one we can call directly; everything else is
       routed through the service worker, which is the only context that
       holds the API key. */
    engineChoice: 'builtin',
    /* The Translator API needs a secure context. In a content script the
       isolated world inherits the page's origin, so on a plain http:// page the
       global is simply absent and the work has to be proxied through the
       extension's own offscreen document instead. */
    useLocalEngine: engine.isSupported(),
    pageScore: 0,
    detected: null,
    reason: '',
  };

  function target() {
    return languages.base(state.settings.targetLanguage);
  }

  function pairName() {
    return languages.nameOf(state.source) + ' → ' + languages.nameOf(target());
  }

  /* ---------- talking to the service worker ---------- */

  const transport = {
    translate(texts) {
      if (state.useLocalEngine) {
        return engine.translateMany(state.source, target(), texts);
      }
      return sendMessage({
        type: MSG.TRANSLATE,
        texts,
        source: state.source,
        target: target(),
      }).then(function (res) {
        if (!res || !res.ok) {
          const err = new Error((res && res.error) || 'Translation backend unavailable.');
          err.code = (res && res.code) || ERR.UNSUPPORTED;
          throw err;
        }
        return res.results;
      });
    },
    async cacheGet(keys) {
      if (!state.settings.cacheEnabled) return {};
      const res = await sendMessage({ type: MSG.CACHE_GET, keys });
      return (res && res.hits) || {};
    },
    async cachePut(entries) {
      if (!state.settings.cacheEnabled) return;
      await sendMessage({ type: MSG.CACHE_PUT, entries });
    },
  };

  /* Streaming only exists on the direct path. Pushing partial results back
     through runtime messaging would cost a round trip per chunk, which is
     more than the progressive rendering is worth, and a cloud provider
     returns a whole batch at once anyway. Installed in resolveEngine()
     once we know the built-in model is the one being used. */
  function installStreaming() {
    if (state.useLocalEngine) {
      transport.translateLong = function (text, onPartial) {
        return engine.translateLong(state.source, target(), text, onPartial);
      };
    } else {
      delete transport.translateLong;
    }
  }

  /* Ask the service worker which translator applies here. It knows the
     settings and whether a provider is configured; this frame only knows
     whether the browser has a built-in model. */
  async function resolveEngine() {
    const res = await sendMessage({
      type: MSG.GET_ENGINE,
      builtinAvailable: engine.isSupported(),
    });
    state.engineChoice = (res && res.engine) || 'builtin';
    state.useLocalEngine = state.engineChoice === 'builtin' && engine.isSupported();
    installStreaming();
  }

  function setStatus(status, message) {
    state.status = status;
    if (typeof message === 'string') state.message = message;
    if (!isTopFrame) return;
    sendMessage({
      type: MSG.REPORT_STATUS,
      status: state.status,
      progress: state.queue ? state.queue.progress : { completed: 0, total: 0 },
    });
  }

  function snapshot() {
    return {
      status: state.status,
      message: state.message,
      reason: state.reason,
      active: state.active,
      selectionOnly: state.selectionOnly,
      source: state.source,
      target: target(),
      pair: pairName(),
      pageScore: Number(state.pageScore.toFixed(3)),
      detected: state.detected,
      engine: state.engineChoice,
      engineDirect: state.useLocalEngine,
      progress: state.queue ? state.queue.progress : { completed: 0, total: 0 },
      stats: Object.assign({}, applier.stats),
      downloadPct: state.downloadPct,
      isTopFrame,
    };
  }

  /* ---------- the document's own language ---------- */

  /* A translated page still claiming lang="hu" makes a screen reader read
     English with Hungarian phonetics, and makes the browser hyphenate it by
     Hungarian rules. Remember what was there so restore() can put it back —
     including the case where there was no attribute at all. */
  let originalDocumentLang = null;
  let documentLangChanged = false;

  function adoptTargetLanguage() {
    if (documentLangChanged || state.selectionOnly) return;
    const root = document.documentElement;
    if (!root) return;
    originalDocumentLang = root.getAttribute('lang');
    root.setAttribute('lang', target());
    documentLangChanged = true;
  }

  function releaseTargetLanguage() {
    if (!documentLangChanged) return;
    const root = document.documentElement;
    if (root) {
      if (originalDocumentLang === null) root.removeAttribute('lang');
      else root.setAttribute('lang', originalDocumentLang);
    }
    documentLangChanged = false;
    originalDocumentLang = null;
  }

  /* ---------- model readiness ---------- */

  function askForClick(text) {
    setStatus(STATUS.NEEDS_DOWNLOAD);
    if (!isTopFrame) return;
    overlay.showCard({
      eyebrow: t('cardEyebrow', '$1 page', [languages.nameOf(state.source)]),
      text,
      action: {
        label: t('cardDownloadAction', 'Download & translate'),
        onClick: function () { start(true); },
      },
      secondary: {
        label: t('cardNotNow', 'Not now'),
        onClick: function () {
          overlay.dismiss();
          setStatus(STATUS.IDLE);
        },
      },
    });
  }

  /* Resolves true when a translator is ready to use. `userGesture` must be true
     only when called from a click handler: Chrome permits the one-time model
     download exclusively inside a user activation, and spending a gesture we do
     not have produces a confusing NotAllowedError instead of a prompt. */
  async function ensureModel(userGesture) {
    const source = state.source;
    const to = target();

    /* Belt and braces. detect.js should never hand over a pair like this,
       but if it ever does, the engine answers with a hard error that
       reads as a browser fault rather than what it is: nothing here to
       translate. */
    if (!source || source === to) {
      setStatus(STATUS.SKIPPED, t('skippedSameLanguage',
        'This is already in $1.', [languages.nameOf(to)]));
      return false;
    }
    if (!languages.isKnown(source)) {
      setStatus(STATUS.SKIPPED, t('skippedUnknownLanguage',
        '“$1” is not a language this browser can translate.', [source]));
      return false;
    }

    if (!state.useLocalEngine) {
      const res = await sendMessage({ type: MSG.ENSURE_MODEL, source, target: to });
      if (res && res.ok) return true;
      if (res && res.code === ERR.CLOUD_UNCONFIGURED) {
        /* Not a browser fault and not something a click here can fix:
           the reader has to go and set a provider up. */
        setStatus(STATUS.ERROR, res.error);
        if (isTopFrame) {
          overlay.showCard({
            tone: 'error',
            eyebrow: t('cardSetupNeeded', 'Setup needed'),
            text: res.error,
          });
        }
        return false;
      }
      if (res && res.code === ERR.NEEDS_GESTURE) {
        askForClick(t('cardNeedsGesture',
          'A one-time language model download is needed. Chrome asks for a ' +
          'click before it will start one.'));
        return false;
      }
      /* The offscreen document is an extension page, so it is a secure
         context and does have the API whenever the browser does. If it
         reports UNSUPPORTED, the browser itself has no Translator at
         all, and "something went wrong" is the wrong thing to say. */
      if (!res || res.code === ERR.UNSUPPORTED) {
        setStatus(STATUS.ERROR, t('errorNoEngine',
          'This browser has no built-in translator. Desktop Chrome 138 or '
          + 'later, or Edge 148 or later, is required.'));
        if (isTopFrame) {
          overlay.showCard({
            tone: 'error',
            eyebrow: t('cardUnavailable', 'Unavailable'),
            text: state.message,
          });
        }
        return false;
      }
      setStatus(STATUS.ERROR, res.error || 'No on-device translator available.');
      return false;
    }

    const availability = await engine.availability(source, to);

    if (availability === 'unsupported' || availability === 'unavailable') {
      setStatus(STATUS.ERROR, t('errorNoPair',
        'This browser has no built-in translator for $1. Desktop Chrome 138+ ' +
        'or Edge 148+ is required.', [pairName()]));
      if (isTopFrame) {
        overlay.showCard({
          tone: 'error',
          eyebrow: t('cardUnavailable', 'Unavailable'),
          text: state.message,
        });
      }
      return false;
    }

    if (availability !== 'available' && !userGesture) {
      askForClick(t('cardNeedsDownload',
        'Translating this page needs a one-time $1 model download. After that ' +
        'it runs offline.', [pairName()]));
      return false;
    }

    try {
      setStatus(availability === 'available' ? STATUS.TRANSLATING : STATUS.DOWNLOADING);
      await engine.ensure(source, to, function (loaded) {
        state.downloadPct = Math.round(loaded * 100);
        overlay.setCardProgress(
          t('cardDownloading', 'Downloading the language model… $1%',
            [state.downloadPct]), loaded);
        setStatus(STATUS.DOWNLOADING);
      });
      return true;
    } catch (err) {
      if (err && err.code === ERR.NEEDS_GESTURE) {
        askForClick(t('cardNeedsGesture',
          'Chrome needs one click before it will download the language model.'));
        return false;
      }
      setStatus(STATUS.ERROR, (err && err.message) || String(err));
      if (isTopFrame) {
        overlay.showCard({
          tone: 'error',
          eyebrow: t('cardFailed', 'Translation failed'),
          text: state.message,
        });
      }
      return false;
    }
  }

  /* ---------- translating ---------- */

  function collectAndQueue(root, filter) {
    const collected = segmenter.collect(root, applier.isDone);
    if (!state.settings.translateAttributes) collected.attrs.length = 0;
    if (filter) {
      collected.segments = collected.segments.filter(filter.segment);
      collected.attrs = collected.attrs.filter(filter.attr);
    }
    if (!collected.segments.length && !collected.attrs.length) return false;
    state.queue.addFromCollection(collected);
    return true;
  }

  async function translateTitle() {
    if (!state.settings.translateTitle || !isTopFrame || state.selectionOnly) return;
    const title = (document.title || '').trim();
    if (!title || !lang.isTranslatable(title)) return;
    try {
      const results = await transport.translate([title]);
      if (results && results[0] && results[0].ok && results[0].text) {
        document.title = results[0].text;
      }
    } catch (_) { /* a failed tab title is not worth surfacing to the user */ }
  }

  function buildQueue() {
    state.glossary = HUEN.glossary.create(state.settings.glossary);
    return HUEN.createQueue({
      source: state.source,
      target: target(),
      transport,
      glossary: state.glossary,
      onProgress: function () {
        setStatus(STATUS.TRANSLATING);
      },
      onError: function (err) {
        setStatus(STATUS.ERROR, (err && err.message) || String(err));
        if (err && err.code === ERR.NEEDS_GESTURE) {
          askForClick(t('cardNeedsGesture',
            'Chrome needs one click before it will download the language model.'));
        }
      },
    });
  }

  /* Watch for content the page adds after load: infinite scroll, tab panels,
     anything a framework renders after hydration. */
  function startObserver() {
    if (state.observer) return;
    let roots = [];
    let timer = null;

    function flush() {
      timer = null;
      const batch = roots;
      roots = [];
      let added = false;
      for (const root of batch) {
        if (!root.isConnected) continue;
        if (collectAndQueue(root)) added = true;
      }
      if (added) state.queue.run();
    }

    state.observer = new MutationObserver(function (mutations) {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
              roots.push(node);
            }
          }
        } else if (mutation.type === 'characterData') {
          // Our own writes land here too; isDone() is what tells them apart.
          if (applier.isDone(mutation.target)) continue;
          roots.push(mutation.target);
        } else if (mutation.type === 'attributes' && mutation.target) {
          if (applier.isDone(mutation.target, mutation.attributeName)) continue;
          roots.push(mutation.target);
        }
      }
      if (roots.length && timer === null) timer = setTimeout(flush, OBSERVER_DEBOUNCE);
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: tags.ATTRS.concat(['value']),
    });
  }

  let starting = false;

  async function start(userGesture) {
    if (starting) return;
    if (state.active && !state.selectionOnly && state.queue && state.queue.isRunning) return;
    starting = true;
    try {
      setStatus(STATUS.CHECKING);
      if (!await ensureModel(!!userGesture)) return;

      overlay.dismiss();
      state.active = true;
      state.selectionOnly = false;
      setStatus(STATUS.TRANSLATING);

      if (!state.queue) state.queue = buildQueue();
      adoptTargetLanguage();

      collectAndQueue(document.body || document.documentElement);
      startObserver();
      translateTitle();
    } finally {
      starting = false;
    }

    await state.queue.run();
    if (state.status === STATUS.TRANSLATING) setStatus(STATUS.DONE);
  }

  /* ---------- translating just what the reader selected ---------- */

  /* The context menu's selection entry used to translate the whole page, which
     is the wrong thing on an English page carrying one foreign quotation.

     The range is used as a filter rather than as the root: collecting from the
     common ancestor and keeping only the segments the range actually touches
     means a sentence that is half-selected is still translated as a whole
     sentence, which is what the model needs. */
  async function translateSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      return start(true);
    }
    const range = selection.getRangeAt(0);
    let root = range.commonAncestorContainer;
    if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
    if (!root) return start(true);

    if (starting) return;
    starting = true;
    try {
      setStatus(STATUS.CHECKING);
      if (!await ensureModel(true)) return;

      overlay.dismiss();
      const fresh = !state.active;
      state.active = true;
      if (fresh) state.selectionOnly = true;
      setStatus(STATUS.TRANSLATING);

      if (!state.queue) state.queue = buildQueue();

      const touches = function (node) {
        try {
          return range.intersectsNode(node);
        } catch (_) {
          return true; // a browser without intersectsNode gets the whole block
        }
      };
      collectAndQueue(root, {
        segment: function (segment) { return segment.nodes.some(touches); },
        attr: function (entry) { return touches(entry.el); },
      });
    } finally {
      starting = false;
    }

    await state.queue.run();
    if (state.status === STATUS.TRANSLATING) setStatus(STATUS.DONE);
  }

  function restore() {
    state.active = false;
    state.selectionOnly = false;
    if (state.queue) state.queue.stop();
    state.queue = null;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    releaseTargetLanguage();
    applier.restoreAll();
    overlay.teardown();
    setStatus(STATUS.IDLE, '');
  }

  /* ---------- hover: show the original behind a phrase ---------- */

  document.addEventListener('mouseover', function (event) {
    if (!state.settings.showOriginalOnHover || !state.active) return;
    const node = event.target;
    if (!node || node.nodeType !== Node.ELEMENT_NODE || !node.closest) return;
    const anchor = node.closest('[data-huen-src]');
    if (!anchor) {
      overlay.hideTip();
      return;
    }
    const original = anchor.getAttribute('data-huen-src');
    if (original) overlay.showTip(anchor, original, state.source);
  }, { passive: true });

  document.addEventListener('mouseout', function (event) {
    const to = event.relatedTarget;
    if (!to || !to.closest || !to.closest('[data-huen-src]')) overlay.hideTip();
  }, { passive: true });

  /* ---------- commands from the popup, menu and keyboard shortcut ---------- */

  serve({
    [MSG.GET_STATE]: function () { return snapshot(); },

    [MSG.TRANSLATE_NOW]: function () {
      /* A click in the popup is a user activation in the popup's own document,
         not in this page, so a missing model still has to be requested through
         the in-page card. */
      start(true);
      return { ok: true };
    },

    [MSG.TRANSLATE_SELECTION]: function () {
      translateSelection();
      return { ok: true };
    },

    [MSG.RESTORE]: function () {
      restore();
      return { ok: true };
    },

    [MSG.TOGGLE]: function () {
      if (state.active) restore();
      else start(true);
      return { ok: true, active: state.active };
    },

    [MSG.SETTINGS_CHANGED]: function (message) {
      state.settings = HUEN.normalizeSettings(message.settings);
      // Switching provider, or pasting a key, changes which translator
      // this frame should be using.
      resolveEngine();
      return { ok: true };
    },
  });

  /* ---------- boot ---------- */

  (async function boot() {
    const res = await sendMessage({ type: MSG.GET_SETTINGS });
    state.settings = HUEN.normalizeSettings(res && res.settings);
    state.source = languages.base(state.settings.sourceLanguage);
    await resolveEngine();

    if (!HUEN.shouldAutoTranslate(state.settings, location.hostname)) {
      state.reason = state.settings.mode === 'manual'
        ? 'the mode is set to manual'
        : 'this site is not set up for automatic translation';
      setStatus(STATUS.IDLE);
      return;
    }

    setStatus(STATUS.CHECKING);
    const verdict = await detect.inspectPage(state.settings);
    state.pageScore = verdict.score;
    state.detected = verdict.detected;
    state.reason = verdict.reason;
    if (verdict.source) state.source = verdict.source;

    if (!verdict.translate) {
      setStatus(STATUS.SKIPPED, t('skippedBecause',
        'Left in the original language because $1.', [verdict.reason]));
      return;
    }

    start(false);
  })();
})(globalThis.HUEN);
