/* The popup.

   It is also the dependable place to trigger the one-time model download: a
   click here is a genuine user activation in an extension page, which is what
   Chrome requires before it will fetch a language model. Once the model is on
   disk it is shared browser-wide, so content scripts can translate afterwards
   with no gesture at all. */
(function (HUEN) {
  'use strict';

  const { engine, browser, MSG, STATUS, statusInfo, sendMessage, sendToTab, t } = HUEN;

  /* The content script pushes a status message on every change, and the popup
     is an extension page, so it receives them. The interval below is only a
     safety net for the one case push cannot cover: a popup opened while a page
     is mid-translation, where the next push may be a second away. */
  const POLL_BUSY = 600;
  const POLL_IDLE = 2500;

  const $ = function (id) { return document.getElementById(id); };

  const el = {
    engine: $('engine'),
    engineText: $('engine-text'),
    stateDot: $('state-dot'),
    stateText: $('state-text'),
    stateDetail: $('state-detail'),
    meter: $('meter'),
    meterFill: $('meter-fill'),
    download: $('download'),
    downloadBtn: $('download-btn'),
    translate: $('translate'),
    restore: $('restore'),
    mode: $('mode'),
    modeHint: $('mode-hint'),
    siteAllow: $('site-allow'),
    siteDeny: $('site-deny'),
    hostAllow: $('host-allow'),
    hostDeny: $('host-deny'),
    hover: $('hover'),
    options: $('options'),
    shortcut: $('shortcut'),
  };

  const MODE_HINT = {
    auto: ['modeAutoHint', 'Every foreign page is translated as it loads.'],
    allowlist: ['modeAllowlistHint', 'Only the sites you have marked below are translated.'],
    manual: ['modeManualHint', 'Nothing is translated until you ask, here or with the shortcut.'],
  };

  let tab = null;
  let host = '';
  let settings = HUEN.normalizeSettings({});
  let pageState = null;
  let pollTimer = null;

  /* The availability of the language pair, tracked separately from whatever any
     page reports. The download offer has to stay visible when the model is
     missing even on a page the content script decided not to touch — otherwise
     the only way to get the model is to find a Hungarian page first. */
  let availability = 'unknown';
  /* Whether this browser has the Translator API at all, as opposed to
     having it but not the model. Null until the check has run. */
  let engineSupported = null;
  /* What the service worker says this page will actually use:
     'builtin', 'cloud', or 'cloud-unconfigured'. */
  let engineChoice = 'builtin';
  let missingApiReason = '';

  function modelMissing() {
    return availability === 'downloadable' || availability === 'downloading';
  }

  /* ---------- rendering ---------- */

  function setEngine(text, tone) {
    el.engineText.textContent = text;
    if (tone) el.engine.setAttribute('data-tone', tone);
    else el.engine.removeAttribute('data-tone');
  }

  function setMeter(percent) {
    if (percent === null) {
      el.meter.hidden = true;
      return;
    }
    el.meter.hidden = false;
    el.meterFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }

  function setDetail(text) {
    el.stateDetail.hidden = !text;
    el.stateDetail.textContent = text || '';
  }

  /* "124 phrases · 18 labels · 3,201 characters"

     `fallbacks` is counted separately and only shown when it is not zero.
     It means the model would not carry the sentence markers through either
     syntax, so those sentences were translated a fragment at a time and read
     worse than the rest. Surfacing it is how you find out a site needs a
     different marker format, instead of just wondering why it reads oddly. */
  function describeWork(stats) {
    const parts = [];
    if (stats.nodes) parts.push(t('workPhrases', '$1 phrases', [stats.nodes.toLocaleString()]));
    if (stats.attrs) parts.push(t('workLabels', '$1 labels', [stats.attrs.toLocaleString()]));
    if (stats.chars) parts.push(t('workChars', '$1 characters', [stats.chars.toLocaleString()]));
    if (stats.fallbacks) {
      parts.push(t('workSplit', '$1 split up', [stats.fallbacks.toLocaleString()]));
    }
    return parts.join(' · ');
  }

  function renderState() {
    const state = pageState;

    /* No Translator API in this browser. Nothing the page reports can
       change that, and nothing either button does can work, so this
       takes priority over the page's own status — which for a frame
       that failed through the offscreen path is the unhelpful
       "Something went wrong". */
    if (engineSupported === false) {
      el.stateDot.setAttribute('data-tone', 'error');
      el.stateText.textContent = t('stateNoEngine', 'No built-in translator');
      setDetail(missingApiReason);
      el.translate.disabled = true;
      el.restore.disabled = true;
      el.download.hidden = true;
      setMeter(null);
      return;
    }

    if (!state) {
      el.stateDot.setAttribute('data-tone', 'neutral');
      el.stateText.textContent = t('stateNoAccess', 'Not available here');
      setDetail(t('stateNoAccessDetail', 'The extension has no access to this page.'));
      el.translate.disabled = true;
      el.restore.disabled = true;
      setMeter(null);
      // The model can still be fetched from here, ready for the next page.
      el.download.hidden = !modelMissing();
      return;
    }

    const info = statusInfo(state.status);
    el.stateDot.setAttribute('data-tone', info.tone);
    el.stateText.textContent = info.label;
    el.translate.disabled = false;
    el.restore.disabled = !state.active;
    el.translate.textContent = state.selectionOnly
      ? t('popupTranslateRest', 'Translate the rest')
      : t('popupTranslate', 'Translate page');

    if (state.status === STATUS.ERROR) {
      setDetail(state.message || '');
    } else if (state.status === STATUS.SKIPPED || state.status === STATUS.IDLE) {
      setDetail(state.reason ? 'Because ' + state.reason + '.' : '');
    } else if (state.status === STATUS.DOWNLOADING) {
      setDetail(state.downloadPct ? state.downloadPct + '% downloaded' : '');
    } else {
      const work = describeWork(state.stats || {});
      /* Which pair was actually used, because with detection on it is not
         necessarily the one in the settings. */
      const pair = state.active && state.pair ? state.pair : '';
      setDetail(pair && work ? pair + ' · ' + work : (work || pair));
    }

    el.download.hidden = !(modelMissing() || state.status === STATUS.NEEDS_DOWNLOAD);

    if (state.status === STATUS.DOWNLOADING) {
      setMeter(state.downloadPct || 0);
    } else if (state.status === STATUS.TRANSLATING && state.progress && state.progress.total) {
      setMeter(Math.round((state.progress.completed / state.progress.total) * 100));
    } else {
      setMeter(null);
    }
  }

  function renderSettings() {
    for (const button of el.mode.querySelectorAll('button')) {
      button.setAttribute('aria-pressed',
        String(button.dataset.mode === settings.mode));
    }
    const hint = MODE_HINT[settings.mode];
    el.modeHint.textContent = hint ? t(hint[0], hint[1]) : '';
    el.hover.checked = settings.showOriginalOnHover;
    el.siteAllow.checked = HUEN.hostMatches(settings.allowlist, host);
    el.siteDeny.checked = HUEN.hostMatches(settings.denylist, host);
    // Without a host there is nothing to add to a list.
    el.siteAllow.disabled = !host;
    el.siteDeny.disabled = !host;
  }

  /* ---------- data ---------- */

  async function pullState() {
    /* The top frame only. Every frame runs a content script and answers
       this, and the first reply is the one that counts, so without this a
       widget iframe reports on the whole page's behalf. */
    pageState = await sendToTab(tab && tab.id, { type: MSG.GET_STATE },
      HUEN.TOP_FRAME);
    renderState();
    schedulePoll();
  }

  function schedulePoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    // Nothing can change while the API is absent, so stop asking.
    if (engineSupported === false) return;
    const busy = pageState && (pageState.status === STATUS.TRANSLATING ||
      pageState.status === STATUS.DOWNLOADING || pageState.status === STATUS.CHECKING);
    pollTimer = setTimeout(pullState, busy ? POLL_BUSY : POLL_IDLE);
  }

  async function patchSettings(update) {
    const res = await sendMessage({ type: MSG.SET_SETTINGS, patch: update });
    settings = HUEN.normalizeSettings(res && res.settings);
    renderSettings();
  }

  async function readEngine() {
    const builtinAvailable = engine.isSupported();
    const res = await sendMessage({
      type: MSG.GET_ENGINE,
      builtinAvailable,
    });
    engineChoice = (res && res.engine) || 'builtin';

    /* A configured service works everywhere, so the absence of a built-in
       model stops being the headline. */
    if (engineChoice === 'cloud') {
      engineSupported = true;
      setEngine(t('engineCloudPill', 'service'), 'ok');
      el.download.hidden = true;
      return true;
    }
    if (engineChoice === 'cloud-unconfigured') {
      engineSupported = false;
      missingApiReason = t('cloudNeedsSetup',
        'Set to use a translation service, but none is set up yet. '
        + 'Open All settings to add one.');
      setEngine(t('engineNeedsSetup', 'needs setup'), 'warn');
      renderState();
      return false;
    }

    if (!builtinAvailable) {
      engineSupported = false;
      /* Name the browser and say why it has no translator — telling someone
         on Chromium 156 that they need "Chrome 138+" is not an answer they
         can act on — and then point at the way round it. */
      missingApiReason = browser.explainMissingApi(await browser.describe(), t) +
        ' ' + t('cloudIsAnOption',
          'A translation service can be used instead \u2014 see All settings.');
      setEngine(t('engineUnavailable', 'unavailable'), 'error');
      el.downloadBtn.disabled = true;
      renderState();
      return false;
    }
    engineSupported = true;

    /* Check the pair the page actually needs. With auto-detection on, a
       German page needs de>en, and reporting on hu>en would tell the
       reader the model is ready when the one they need is not. */
    const source = (pageState && pageState.source) || settings.sourceLanguage;
    availability = await engine.availability(source, settings.targetLanguage);

    if (availability === 'available') {
      setEngine(t('engineOnDevice', 'on-device'), 'ok');
      el.download.hidden = true;
    } else if (availability === 'downloading') {
      setEngine(t('engineDownloading', 'downloading'), 'warn');
    } else if (availability === 'downloadable') {
      setEngine(t('engineNeedsDownload', 'needs download'), 'warn');
    } else {
      setEngine(t('engineUnsupportedPair', 'pair unsupported'), 'error');
      el.downloadBtn.disabled = true;
      el.download.hidden = true;
    }
    return true;
  }

  /* ---------- events ---------- */

  el.downloadBtn.addEventListener('click', async function () {
    el.downloadBtn.disabled = true;
    setEngine('downloading', 'warn');
    el.stateDot.setAttribute('data-tone', 'busy');
    setMeter(0);
    try {
      await engine.ensure(settings.sourceLanguage, settings.targetLanguage,
        function (loaded) {
          const percent = Math.round(loaded * 100);
          setMeter(percent);
          el.stateText.textContent = 'Fetching the language model';
          setDetail(percent + '% downloaded');
        });
      availability = 'available';
      setEngine('on-device', 'ok');
      el.download.hidden = true;
      setMeter(null);
      el.stateText.textContent = 'Model ready';
      setDetail('Translating this page…');
      await sendToTab(tab && tab.id, { type: MSG.TRANSLATE_NOW });
      setTimeout(pullState, 500);
    } catch (err) {
      setMeter(null);
      setEngine('download failed', 'error');
      el.stateDot.setAttribute('data-tone', 'error');
      el.stateText.textContent = 'Download failed';
      setDetail((err && err.message) || String(err));
      el.downloadBtn.disabled = false;
    }
  });

  el.translate.addEventListener('click', async function () {
    el.stateDot.setAttribute('data-tone', 'busy');
    el.stateText.textContent = 'Translating';
    await sendToTab(tab && tab.id, { type: MSG.TRANSLATE_NOW });
    setTimeout(pullState, 400);
  });

  el.restore.addEventListener('click', async function () {
    await sendToTab(tab && tab.id, { type: MSG.RESTORE });
    setTimeout(pullState, 200);
  });

  el.mode.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    patchSettings({ mode: button.dataset.mode });
  });

  el.hover.addEventListener('change', function () {
    patchSettings({ showOriginalOnHover: el.hover.checked });
  });

  /* The two site switches are mutually exclusive: a site cannot be both always
     and never translated, and letting the user set both would leave the
     denylist silently winning. */
  el.siteAllow.addEventListener('change', function () {
    const on = el.siteAllow.checked;
    patchSettings({
      allowlist: HUEN.withHost(settings.allowlist, host, on),
      denylist: on ? HUEN.withHost(settings.denylist, host, false) : settings.denylist,
    });
  });

  el.siteDeny.addEventListener('change', async function () {
    const on = el.siteDeny.checked;
    await patchSettings({
      denylist: HUEN.withHost(settings.denylist, host, on),
      allowlist: on ? HUEN.withHost(settings.allowlist, host, false) : settings.allowlist,
    });
    // Switching a site off should put the page back, not leave English behind.
    if (on && pageState && pageState.active) {
      await sendToTab(tab && tab.id, { type: MSG.RESTORE });
      pullState();
    }
  });

  el.options.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  /* Status pushed from the page we are looking at. */
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== MSG.REPORT_STATUS) return;
    if (!tab || !sender || !sender.tab || sender.tab.id !== tab.id) return;
    pullState();
  });

  /* ---------- boot ---------- */

  (async function boot() {
    HUEN.i18n.apply();
    const tabs = await new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, resolve);
    });
    tab = tabs && tabs[0];
    try {
      host = tab && tab.url ? HUEN.normalizeHost(new URL(tab.url).hostname) : '';
    } catch (_) {
      host = '';
    }
    el.hostAllow.textContent = host || 'this site';
    el.hostDeny.textContent = host || 'this site';

    const res = await sendMessage({ type: MSG.GET_SETTINGS });
    settings = HUEN.normalizeSettings(res && res.settings);
    renderSettings();

    /* Order matters: readEngine() checks the pair the page actually needs, so
       the page has to be asked what language it is first. The state is then
       rendered again, because whether to offer the download depends on the
       availability readEngine() just worked out. */
    await pullState();
    if (await readEngine()) renderState();

    chrome.commands.getAll(function (commands) {
      const toggle = (commands || []).find(function (command) {
        return command.name === 'toggle-translation';
      });
      if (toggle && toggle.shortcut) el.shortcut.textContent = toggle.shortcut;
      else el.shortcut.hidden = true;
    });
  })();
})(globalThis.HUEN);
