/* Wrapper around Chrome's built-in on-device Translator API.

   What the API's shape forces on this file:
   - It is a bare global, `Translator`, on desktop Chrome 138+ / Edge 148+.
   - It does NOT exist in workers, the MV3 service worker included, so this
     file is only ever loaded into a DOM context: the content script, the popup,
     the options page, or the offscreen document.
   - The first create() for a language pair downloads a model and requires user
     activation. Afterwards the pair reports 'available' and needs no gesture.
   - Translation is processed sequentially inside the browser. Firing calls in
     parallel does not make it faster, it just queues them behind each other
     and makes failures harder to attribute, hence the explicit serialisation
     at the bottom of this file. */
(function (HUEN) {
  'use strict';

  const ERR = HUEN.ERR;

  const MAX_CHUNK = 1800; // characters per translate() call

  const state = {
    translators: new Map(), // "hu>en" -> Translator instance
    creating: new Map(),    // "hu>en" -> in-flight create promise
    chain: Promise.resolve(),
  };

  function pairKey(source, target) {
    return source + '>' + target;
  }

  function tagged(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function isSupported() {
    return typeof globalThis.Translator !== 'undefined';
  }

  /* 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' */
  async function availability(source, target) {
    if (!isSupported()) return 'unsupported';
    try {
      return await Translator.availability({ sourceLanguage: source, targetLanguage: target });
    } catch (_) {
      return 'unsupported';
    }
  }

  /* Get (or build) a translator for a pair. `onProgress` receives a 0..1
     fraction during the one-time model download.

     Concurrent callers share one create promise: two frames of the same page
     both asking for hu>en must not start two downloads. */
  function ensure(source, target, onProgress) {
    const key = pairKey(source, target);

    const existing = state.translators.get(key);
    if (existing) return Promise.resolve(existing);

    const inFlight = state.creating.get(key);
    if (inFlight) return inFlight;

    const promise = create(source, target, onProgress).then(function (translator) {
      state.translators.set(key, translator);
      return translator;
    });

    state.creating.set(key, promise);
    promise.catch(function () {}).then(function () { state.creating.delete(key); });
    return promise;
  }

  async function create(source, target, onProgress) {
    if (!isSupported()) {
      throw tagged(ERR.UNSUPPORTED, 'This browser has no built-in Translator API.');
    }
    const options = { sourceLanguage: source, targetLanguage: target };
    if (typeof onProgress === 'function') {
      options.monitor = function (monitor) {
        monitor.addEventListener('downloadprogress', function (event) {
          try { onProgress(event.loaded); } catch (_) { /* a bad listener is not fatal */ }
        });
      };
    }
    try {
      return await Translator.create(options);
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'NotReadableError') {
        throw tagged(ERR.NEEDS_GESTURE,
          'Chrome needs a click before it will download the language model.');
      }
      if (name === 'NotSupportedError') {
        throw tagged(ERR.PAIR_UNSUPPORTED,
          'This browser cannot translate ' + source + ' to ' + target + '.');
      }
      throw tagged(ERR.CREATE_FAILED, (err && err.message) || String(err));
    }
  }

  /* Split text that exceeds the per-call budget, preferring sentence and then
     word boundaries so the model always sees grammatical units. */
  function chunk(text) {
    if (text.length <= MAX_CHUNK) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > MAX_CHUNK) {
      const head = rest.slice(0, MAX_CHUNK);
      let cut = Math.max(
        head.lastIndexOf('. '), head.lastIndexOf('! '),
        head.lastIndexOf('? '), head.lastIndexOf('\n')
      );
      // A boundary in the first half means the chunk would be mostly empty;
      // fall back to a word break, then to a hard cut.
      if (cut < MAX_CHUNK * 0.5) cut = head.lastIndexOf(' ');
      if (cut < MAX_CHUNK * 0.5) cut = MAX_CHUNK;
      else cut += 1;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    return parts;
  }

  /* Run work serially, in call order. */
  function serial(task) {
    const run = state.chain.then(task, task);
    state.chain = run.catch(function () {});
    return run;
  }

  async function translateOne(source, target, text) {
    const translator = await ensure(source, target);
    const pieces = chunk(text);
    if (pieces.length === 1) return translator.translate(text);
    const out = [];
    for (const piece of pieces) out.push(await translator.translate(piece));
    return out.join('');
  }

  function supportsStreaming(translator) {
    return !!translator && typeof translator.translateStreaming === 'function';
  }

  /* Translate one string, handing partial output to `onPartial` as it arrives.

     Worth it only for a long block: a 900-character paragraph takes long
     enough that watching it fill in beats watching nothing happen. Short
     strings go through translateOne, where one call is cheaper than the
     stream machinery.

     The spec says the stream yields deltas, but Chrome's other built-in AI
     APIs shipped cumulative chunks first and changed later, so this handles
     both: a chunk that already starts with everything seen so far is treated
     as cumulative, anything else is appended. Guessing wrong in either
     direction would duplicate or lose text. */
  async function translateStreaming(source, target, text, onPartial) {
    const translator = await ensure(source, target);
    if (!supportsStreaming(translator) || chunk(text).length > 1) {
      const whole = await translateOne(source, target, text);
      if (typeof onPartial === 'function') onPartial(whole);
      return whole;
    }

    const reader = translator.translateStreaming(text).getReader();
    let full = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const piece = String(value == null ? '' : value);
        if (!piece) continue;
        if (piece.length >= full.length && piece.startsWith(full)) full = piece;
        else full += piece;
        if (typeof onPartial === 'function') onPartial(full);
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* already closed */ }
    }
    return full;
  }

  /* Translate one long string on its own, reporting progress. Same result
     shape as translateMany's entries, and serialised on the same chain so it
     cannot overtake a batch already queued. */
  function translateLong(source, target, text, onPartial) {
    return serial(async function () {
      try {
        return { ok: true, text: await translateStreaming(source, target, text, onPartial) };
      } catch (err) {
        return {
          ok: false,
          code: (err && err.code) || ERR.CREATE_FAILED,
          error: (err && err.message) || String(err),
        };
      }
    });
  }

  /* Translate an array of strings. Resolves to an array of
     { ok: true, text } | { ok: false, code, error } in the same order, so one
     string that the model chokes on cannot take the whole batch down. */
  function translateMany(source, target, texts) {
    return serial(async function () {
      const results = [];
      for (const text of texts) {
        try {
          results.push({ ok: true, text: await translateOne(source, target, text) });
        } catch (err) {
          results.push({
            ok: false,
            code: (err && err.code) || ERR.CREATE_FAILED,
            error: (err && err.message) || String(err),
          });
        }
      }
      return results;
    });
  }

  HUEN.engine = {
    isSupported,
    availability,
    ensure,
    translateMany,
    translateLong,
    chunk,
    MAX_CHUNK,
  };
})(globalThis.HUEN);
