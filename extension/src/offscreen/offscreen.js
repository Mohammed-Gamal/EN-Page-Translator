/* Offscreen translation host. See background/offscreen-host.js for why this
   document exists at all. */
(function (HUEN) {
  'use strict';

  const { engine, MSG, ERR } = HUEN;

  function unsupported() {
    return { ok: false, code: ERR.UNSUPPORTED, error: 'No built-in Translator API.' };
  }

  HUEN.serve({
    [MSG.OFFSCREEN_ENSURE]: async function (message) {
      if (!engine.isSupported()) return unsupported();

      const availability = await engine.availability(message.source, message.target);

      if (availability !== 'available') {
        /* This document has no user activation and never will, so it cannot
           start the download. Say which of the two cases it is, so the caller
           knows whether to ask the user for a click or give up. */
        const downloadable = availability === 'downloadable' || availability === 'downloading';
        return {
          ok: false,
          availability,
          code: downloadable ? ERR.NEEDS_GESTURE : ERR.PAIR_UNSUPPORTED,
          error: downloadable
            ? 'The language model still needs its one-time download. Start it from the extension popup.'
            : 'This browser cannot translate that language pair.',
        };
      }

      try {
        await engine.ensure(message.source, message.target);
        return { ok: true, availability };
      } catch (err) {
        return { ok: false, code: err.code || ERR.CREATE_FAILED, error: err.message };
      }
    },

    [MSG.OFFSCREEN_TRANSLATE]: async function (message) {
      if (!engine.isSupported()) return unsupported();
      try {
        const results = await engine.translateMany(
          message.source, message.target, message.texts || []);
        return { ok: true, results };
      } catch (err) {
        return { ok: false, code: err.code || ERR.CREATE_FAILED, error: err.message };
      }
    },
  });
})(globalThis.HUEN);
