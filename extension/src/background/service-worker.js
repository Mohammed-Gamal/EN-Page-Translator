/* Service worker: settings, the toolbar badge, the message router, and the
   browser-level plumbing (keyboard command, context menu, install).

   It never translates anything itself — the Translator API does not exist in
   workers. Page text passes through here only when the content script cannot
   reach the API from its own context; see offscreen-host.js. */

importScripts(
  '/src/shared/namespace.js',
  '/src/shared/protocol.js',
  '/src/shared/settings.js',
  '/src/shared/languages.js',
  '/src/background/cloud.js',
  '/src/background/cache.js',
  '/src/background/offscreen-host.js'
);

const HUEN = globalThis.HUEN;
const { MSG, ERR, cache, cloud, offscreenHost, statusInfo, sendToTab, t } = HUEN;

/* Which translator a given page should use.

   The content script asks before it starts, because the answer decides
   whether it talks to the browser's own model directly or routes every
   batch through here. Only this context ever sees the API key. */
function chooseEngine(settings, builtinAvailable) {
  const configured = cloud.isConfigured(settings);
  if (settings.engine === 'cloud') return configured ? 'cloud' : 'cloud-unconfigured';
  if (settings.engine === 'builtin') return 'builtin';
  if (builtinAvailable) return 'builtin';
  return configured ? 'cloud' : 'builtin';
}

/* ---------- settings ---------- */

async function getSettings() {
  const stored = await chrome.storage.local.get(HUEN.SETTINGS_KEY);
  return HUEN.normalizeSettings(stored && stored[HUEN.SETTINGS_KEY]);
}

async function setSettings(patch) {
  const next = HUEN.normalizeSettings(Object.assign({}, await getSettings(), patch));
  await chrome.storage.local.set({ [HUEN.SETTINGS_KEY]: next });
  announce(next);
  return next;
}

/* Tell every open tab, so a settings change takes effect without a reload. */
function announce(settings) {
  chrome.tabs.query({}, function (tabs) {
    for (const tab of tabs) {
      if (tab.id) sendToTab(tab.id, { type: MSG.SETTINGS_CHANGED, settings });
    }
  });
}

/* ---------- toolbar badge ---------- */

function setBadge(tabId, status) {
  const info = statusInfo(status);
  try {
    chrome.action.setBadgeText({ tabId, text: info.badge });
    chrome.action.setBadgeBackgroundColor({ tabId, color: info.badgeColor });
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
    chrome.action.setTitle({
      tabId,
      title: t('appShortName', 'Magyar → English') + ' · ' + info.label,
    });
  } catch (_) { /* the tab closed while the message was in flight */ }
}

/* ---------- message router ---------- */

HUEN.serve({
  [MSG.GET_SETTINGS]: async function () {
    return { settings: await getSettings() };
  },

  [MSG.SET_SETTINGS]: async function (message) {
    return { settings: await setSettings(message.patch || {}) };
  },

  [MSG.CACHE_GET]: async function (message) {
    return { hits: await cache.get(message.keys) };
  },

  [MSG.CACHE_PUT]: async function (message) {
    const settings = await getSettings();
    await cache.put(message.entries, settings.cacheLimit);
    return { ok: true };
  },

  [MSG.CACHE_STATS]: async function () {
    return { stats: await cache.stats() };
  },

  [MSG.CACHE_CLEAR]: async function () {
    return { ok: true, removed: await cache.clear() };
  },

  [MSG.GET_ENGINE]: async function (message) {
    const settings = await getSettings();
    return { engine: chooseEngine(settings, !!message.builtinAvailable) };
  },

  [MSG.TRANSLATE]: async function (message) {
    const settings = await getSettings();
    if (chooseEngine(settings, false) !== 'cloud') {
      return offscreenHost.translate(message.texts, message.source, message.target);
    }
    try {
      const results = await cloud.translateMany(
        settings, message.texts || [], message.source, message.target);
      return { ok: true, results };
    } catch (err) {
      return {
        ok: false,
        code: (err && err.code) || ERR.CLOUD_FAILED,
        error: (err && err.message) || String(err),
      };
    }
  },

  [MSG.ENSURE_MODEL]: async function (message) {
    const settings = await getSettings();
    const choice = chooseEngine(settings, false);
    if (choice === 'cloud-unconfigured') {
      return {
        ok: false,
        code: ERR.CLOUD_UNCONFIGURED,
        error: t('errorCloudUnconfigured',
          'No translation service is set up yet. Add one in the extension settings.'),
      };
    }
    // A cloud provider has nothing to download, so it is ready as soon
    // as it is configured.
    if (choice === 'cloud') return { ok: true, engine: 'cloud' };
    return offscreenHost.ensureModel(message.source, message.target);
  },

  /* Used by the options page's "Test" button, so the reader finds out the
     key is wrong there rather than on a page they wanted to read. */
  [MSG.TEST_CLOUD]: async function (message) {
    const settings = HUEN.normalizeSettings(
      Object.assign({}, await getSettings(), message.patch || {}));
    if (!cloud.isConfigured(settings)) {
      return { ok: false, error: t('cloudTestNoKey', 'No API key set.') };
    }
    try {
      const results = await cloud.translateMany(
        settings, ['Jó napot kívánok!'], 'hu', 'en');
      return { ok: true, sample: (results[0] && results[0].text) || '' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  },

  [MSG.REPORT_STATUS]: function (message, sender) {
    if (sender && sender.tab && sender.tab.id) setBadge(sender.tab.id, message.status);
    return { ok: true };
  },
});

/* ---------- browser-level plumbing ---------- */

chrome.commands.onCommand.addListener(function (command) {
  if (command !== 'toggle-translation') return;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs && tabs[0];
    if (tab && tab.id) sendToTab(tab.id, { type: MSG.TOGGLE });
  });
});

/* Two entries, because they are genuinely different actions. The selection
   one used to translate the whole page, which is the wrong thing to do on an
   English page carrying a single foreign quotation. */
const MENU_PAGE = 'huen-translate-page';
const MENU_SELECTION = 'huen-translate-selection';

function buildMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: t('menuTranslatePage', 'Translate this page'),
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: t('menuTranslateSelection', 'Translate the selected text'),
      contexts: ['selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(function () {
  buildMenus();
  // Writes the defaults on first install so the options page has something
  // concrete to show rather than an empty object.
  getSettings().then(function (settings) {
    chrome.storage.local.set({ [HUEN.SETTINGS_KEY]: settings });
  });
  // Move any cache left by an older version out of chrome.storage.local.
  cache.migrateOnce();
});

// Menus do not survive a browser restart on their own.
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || !tab.id) return;
  if (info.menuItemId === MENU_PAGE) {
    sendToTab(tab.id, { type: MSG.TRANSLATE_NOW });
  } else if (info.menuItemId === MENU_SELECTION) {
    sendToTab(tab.id, { type: MSG.TRANSLATE_SELECTION });
  }
});

/* A navigation replaces the content script, so the badge has to be cleared or
   it keeps claiming the previous page's state. */
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status === 'loading') setBadge(tabId, HUEN.STATUS.IDLE);
});
