/* Options page.

   Everything is edited against one in-memory copy of the settings and written
   in a single save, so a half-finished hostname in a textarea never reaches
   storage and the save bar can honestly say whether anything has changed. */
(function (HUEN) {
  'use strict';

  const { engine, languages, MSG, sendMessage, t } = HUEN;

  const SWITCHES = [
    'translateAttributes', 'translateTitle', 'showOriginalOnHover', 'cacheEnabled',
    'autoDetectSource',
  ];

  const PAIR_LABEL = {
    available: ['pairReady',
      'Ready — the model for this pair is already on your disk.'],
    downloadable: ['pairDownloadable',
      'Supported — the model downloads the first time you use it.'],
    downloading: ['pairDownloading',
      'The model for this pair is downloading now.'],
    unavailable: ['pairUnsupported', 'This browser cannot translate this pair.'],
    unsupported: ['pairUnsupported', 'This browser cannot translate this pair.'],
  };

  const $ = function (id) { return document.getElementById(id); };

  let saved = HUEN.normalizeSettings({});

  /* ---------- form <-> settings ---------- */

  function fillLanguages(select, selected) {
    select.textContent = '';
    for (const code of languages.CODES) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = languages.NAMES[code];
      if (code === selected) option.selected = true;
      select.appendChild(option);
    }
  }

  /* Hostnames never contain whitespace, so splitting on it is safe. */
  function parseList(text) {
    return String(text || '').split(/[\s,;]+/).filter(Boolean);
  }

  /* Glossary terms very much do contain spaces ("Ügyfélkapu Plusz"), so
     these are one per line and keep their internal spacing. */
  function parseLines(text) {
    return String(text || '').split(/\r?\n/)
      .map(function (line) { return line.trim(); })
      .filter(Boolean);
  }

  function writeForm(settings) {
    $('mode').value = settings.mode;
    $('minScore').value = settings.minScore;
    $('minScore-out').textContent = Number(settings.minScore).toFixed(2);
    $('allowlist').value = settings.allowlist.join('\n');
    $('denylist').value = settings.denylist.join('\n');
    $('glossary').value = settings.glossary.join('\n');
    $('cacheLimit').value = settings.cacheLimit;
    for (const key of SWITCHES) $(key).checked = !!settings[key];
    fillLanguages($('sourceLanguage'), settings.sourceLanguage);
    fillLanguages($('targetLanguage'), settings.targetLanguage);
    reflectAutoDetect();
  }

  /* With detection on, the "From" menu is a fallback rather than the
     choice, and the label should say so instead of quietly meaning
     something different from what it reads. */
  function reflectAutoDetect() {
    $('source-label').textContent = $('autoDetectSource').checked
      ? t('optionsFromFallback', 'From (when detection fails)')
      : t('optionsFrom', 'From');
  }

  /* Run the form through the same normaliser the rest of the extension uses, so
     the comparison below is between two canonical objects and a reordered
     allowlist does not read as a change. */
  function readForm() {
    const patch = {
      mode: $('mode').value,
      minScore: Number($('minScore').value),
      allowlist: parseList($('allowlist').value),
      denylist: parseList($('denylist').value),
      glossary: parseLines($('glossary').value),
      cacheLimit: Number($('cacheLimit').value),
      sourceLanguage: $('sourceLanguage').value,
      targetLanguage: $('targetLanguage').value,
    };
    for (const key of SWITCHES) patch[key] = $(key).checked;
    return HUEN.normalizeSettings(Object.assign({}, saved, patch));
  }

  function isDirty() {
    return JSON.stringify(readForm()) !== JSON.stringify(saved);
  }

  function refreshSaveBar() {
    $('savebar').dataset.open = String(isDirty());
  }

  let toastTimer = null;
  function toast(text) {
    const node = $('toast');
    node.textContent = text;
    node.dataset.open = 'true';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.dataset.open = 'false'; }, 1800);
  }

  /* ---------- actions ---------- */

  async function save() {
    const next = readForm();
    const res = await sendMessage({ type: MSG.SET_SETTINGS, patch: next });
    saved = HUEN.normalizeSettings(res && res.settings);
    writeForm(saved);
    refreshSaveBar();
    toast(t('optionsSaved', 'Settings saved'));
    await checkPair();
  }

  function revert() {
    writeForm(saved);
    refreshSaveBar();
    checkPair();
  }

  async function resetAll() {
    const res = await sendMessage({ type: MSG.SET_SETTINGS, patch: HUEN.DEFAULTS });
    saved = HUEN.normalizeSettings(res && res.settings);
    writeForm(saved);
    refreshSaveBar();
    toast(t('optionsResetDone', 'Back to defaults'));
    await checkPair();
  }

  async function checkPair() {
    const source = $('sourceLanguage').value;
    const target = $('targetLanguage').value;
    const node = $('pair-status');

    if (source === target) {
      node.textContent = 'Source and target are the same language.';
      return;
    }
    if (!engine.isSupported()) {
      node.textContent = 'This browser has no built-in Translator API.';
      return;
    }
    const availability = await engine.availability(source, target);
    const label = PAIR_LABEL[availability];
    node.textContent = label ? t(label[0], label[1]) : ('Availability: ' + availability);
  }

  async function showCacheStats() {
    const res = await sendMessage({ type: MSG.CACHE_STATS });
    const stats = (res && res.stats) || { entries: 0, bytes: 0 };
    /* The byte figure is extrapolated from a sample rather than measured,
       which is why it is only ever shown as "about". */
    $('cache-stats').textContent = stats.entries
      ? t('optionsCacheStats', '$1 phrases remembered, about $2 KB', [
        stats.entries.toLocaleString(),
        Math.max(1, Math.round(stats.bytes / 1024)).toLocaleString(),
      ])
      : t('optionsCacheEmpty', 'Nothing remembered yet.');
  }

  /* ---------- diagnostics ---------- */

  function diagRow(list, term, value, tone) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    if (tone) dd.dataset.tone = tone;
    list.appendChild(dt);
    list.appendChild(dd);
  }

  async function showDiagnostics() {
    const list = $('diag');
    list.textContent = '';

    const ua = navigator.userAgent;
    const edge = (/Edg\/([\d.]+)/.exec(ua) || [])[1];
    const chrome_ = (/Chrom(?:e|ium)\/([\d.]+)/.exec(ua) || [])[1];
    diagRow(list, t('diagBrowser', 'Browser'),
      edge ? 'Edge ' + edge : 'Chrome ' + (chrome_ || 'unknown'));

    const supported = engine.isSupported();
    diagRow(list, 'Translator API', supported ? 'present' : 'missing',
      supported ? 'ok' : 'error');

    const hasDetector = typeof globalThis.LanguageDetector !== 'undefined';
    diagRow(list, 'LanguageDetector API',
      hasDetector ? 'present' : 'missing (optional)', hasDetector ? 'ok' : null);

    if (supported) {
      const source = $('sourceLanguage').value;
      const target = $('targetLanguage').value;
      const availability = await engine.availability(source, target);
      diagRow(list, source + ' → ' + target, availability,
        availability === 'available' ? 'ok' : 'warn');
    }

    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        diagRow(list, t('diagStorage', 'Storage used'),
          Math.round((estimate.usage || 0) / 1024).toLocaleString('en-US') + ' KB');
      } catch (_) { /* the estimate is a nicety, not a requirement */ }
    }

    diagRow(list, t('diagExtension', 'Extension'),
      t('diagVersion', 'version $1', [chrome.runtime.getManifest().version]));

    const note = $('diag-note');
    if (supported) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    note.textContent =
      'The built-in Translator needs desktop Chrome 138+ or Edge 148+, and does ' +
      'not exist on mobile at all. If your browser is new enough but the API is ' +
      'still missing, check that the built-in AI flags are enabled at ' +
      'chrome://flags and that the drive holding your browser profile has room ' +
      'for the model.';
  }

  /* ---------- wiring ---------- */

  $('save').addEventListener('click', save);
  $('revert').addEventListener('click', revert);
  $('reset').addEventListener('click', resetAll);
  $('clear-cache').addEventListener('click', async function () {
    await sendMessage({ type: MSG.CACHE_CLEAR });
    await showCacheStats();
    toast(t('optionsCacheCleared', 'Remembered phrases cleared'));
  });

  $('minScore').addEventListener('input', function () {
    $('minScore-out').textContent = Number($('minScore').value).toFixed(2);
  });

  $('autoDetectSource').addEventListener('change', reflectAutoDetect);

  document.addEventListener('input', refreshSaveBar);
  document.addEventListener('change', refreshSaveBar);

  for (const id of ['sourceLanguage', 'targetLanguage']) {
    $(id).addEventListener('change', function () {
      checkPair();
      showDiagnostics();
    });
  }

  /* Ctrl/Cmd+S is what anyone editing a form of this shape will reach for. */
  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (isDirty()) save();
    }
  });

  window.addEventListener('beforeunload', function (event) {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  (async function load() {
    HUEN.i18n.apply();
    const res = await sendMessage({ type: MSG.GET_SETTINGS });
    saved = HUEN.normalizeSettings(res && res.settings);
    writeForm(saved);
    refreshSaveBar();
    await checkPair();
    await showCacheStats();
    await showDiagnostics();
  })();
})(globalThis.HUEN);
