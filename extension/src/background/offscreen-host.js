/* The offscreen document, which exists for one reason.

   Chrome's Translator API needs a secure context. A content script runs in an
   isolated world but inherits the page's origin, so on a plain http:// page the
   `Translator` global is simply not there. The extension's own pages are
   chrome-extension://, which *is* secure, and an offscreen document is the only
   way an MV3 extension can keep such a page alive without a visible tab.

   The catch, and it is a real one: an offscreen document never has user
   activation, so it cannot trigger the first-time model download. That has to
   happen from the popup or from an in-page prompt. Once any context has pulled
   the model down it is shared browser-wide, and this path works unattended. */
(function (HUEN) {
  'use strict';

  const PATH = 'src/offscreen/offscreen.html';
  const { MSG, ERR, sendMessage } = HUEN;

  let ready = null;

  async function exists() {
    if (!chrome.runtime.getContexts) return false;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    return contexts.length > 0;
  }

  function ensure() {
    if (ready) return ready;
    ready = (async function () {
      if (await exists()) return true;
      try {
        await chrome.offscreen.createDocument({
          url: PATH,
          reasons: ['DOM_PARSER'],
          justification:
            'Chrome’s built-in Translator API is unavailable in service ' +
            'workers, so translation runs in an offscreen DOM context.',
        });
        return true;
      } catch (err) {
        // Two messages arriving together both try to create it; whoever loses
        // the race finds it already there.
        if (await exists()) return true;
        ready = null;
        throw err;
      }
    })();
    return ready;
  }

  function failure(err) {
    return {
      ok: false,
      code: ERR.UNSUPPORTED,
      error: String((err && err.message) || err),
    };
  }

  async function ask(message) {
    try {
      await ensure();
    } catch (err) {
      return failure(err);
    }
    const response = await sendMessage(message);
    return response || { ok: false, code: ERR.UNSUPPORTED, error: 'No response from the offscreen document.' };
  }

  function translate(texts, source, target) {
    return ask({ type: MSG.OFFSCREEN_TRANSLATE, texts, source, target });
  }

  function ensureModel(source, target) {
    return ask({ type: MSG.OFFSCREEN_ENSURE, source, target });
  }

  HUEN.offscreenHost = { translate, ensureModel };
})(globalThis.HUEN);
