/* The scheduler.

   Responsibilities:
   - Order work so text in the viewport is translated first, which is what
     makes a long article readable immediately instead of filling in from the
     top down.
   - Consult the persistent cache before translating anything. Site chrome
     ("Bejelentkezés", "Kapcsolat", …) repeats across every page of a site, so
     after the first few pages the cache does most of the work.
   - Batch, then yield to the event loop so the page never janks.
   - Climb down gracefully when the model will not cooperate: a second marker
     syntax, then unprotected text, then node-by-node. */
(function (HUEN) {
  'use strict';

  const { segmenter, applier, hash, lang, isFatalCode } = HUEN;

  const BATCH_SIZE = 10;
  /* Below this, one plain call beats the streaming machinery. Above it, the
     wait is long enough that watching the text fill in is better than watching
     nothing happen. */
  const STREAM_MIN = 400;
  /* How much to count as "nearly visible". Generous downwards, because that is
     where the reader is heading. */
  const VIEWPORT_MARGIN = '600px 0px 800px 0px';
  /* How long to wait for the first batch of visibility callbacks before
     starting anyway. An IntersectionObserver reports asynchronously, so
     without this the first batch would be picked in document order. */
  const FIRST_FLUSH_MS = 60;

  function itemElement(item) {
    if (item.kind === 'segment') {
      const container = item.segment.container;
      return container && container.nodeType === Node.ELEMENT_NODE ? container : null;
    }
    if (item.kind === 'node') return item.node.parentElement;
    return item.el;
  }

  function createQueue(options) {
    const source = options.source || 'hu';
    const target = options.target || 'en';
    const onProgress = options.onProgress || function () {};
    const onError = options.onError || function () {};
    const transport = options.transport;
    const glossary = options.glossary || HUEN.glossary.create([]);
    /* Translations made under one glossary are not interchangeable with ones
       made under another, or under none, so they must not share cache
       entries. */
    const cacheSalt = glossary.fingerprint || '';

    const pending = [];
    let running = false;
    let cancelled = false;
    let seen = 0;
    let completed = 0;

    /* ---------- what is on screen ---------- */

    /* The previous implementation called getBoundingClientRect() on every
       pending item on every batch. That is quadratic in the length of the
       page, and worse, each batch had just written to the DOM, so the first
       read of each batch forced a full layout flush. An IntersectionObserver
       does the same job with no layout reads at all: the browser tells us when
       something comes into view, and picking a batch becomes a WeakSet
       lookup. */
    const nearViewport = new WeakSet();
    let observer = null;
    let firstFlush = null;
    let resolveFirstFlush = null;

    function ensureObserver() {
      if (observer || typeof IntersectionObserver === 'undefined') return;
      firstFlush = new Promise(function (resolve) { resolveFirstFlush = resolve; });
      observer = new IntersectionObserver(function (entries) {
        for (const entry of entries) {
          if (entry.isIntersecting) nearViewport.add(entry.target);
          else nearViewport.delete(entry.target);
        }
        if (resolveFirstFlush) {
          resolveFirstFlush();
          resolveFirstFlush = null;
        }
      }, { rootMargin: VIEWPORT_MARGIN });
    }

    function watch(item) {
      if (!observer) return;
      const element = itemElement(item);
      if (!element) return;
      try {
        observer.observe(element);
      } catch (_) { /* detached between collection and here */ }
    }

    /* An IntersectionObserver holds its targets strongly, so a long-lived
       single-page app would accumulate every element it ever translated. */
    function releaseObserver() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
      firstFlush = null;
      resolveFirstFlush = null;
    }

    /* ---------- filling the queue ---------- */

    function push(item) {
      pending.push(item);
      watch(item);
    }

    function addFromCollection(collected) {
      ensureObserver();
      for (const segment of collected.segments) {
        // A heading that is nothing but a brand name never needs the model.
        if (segment.texts.length === 1 && glossary.isExactTerm(segment.texts[0])) continue;
        push({ kind: 'segment', segment, markerStyle: 0, protect: true });
      }
      for (const attr of collected.attrs) {
        if (glossary.isExactTerm(attr.text)) continue;
        push({ kind: 'attr', el: attr.el, attr: attr.attr, text: attr.text, protect: true });
      }
      seen = Math.max(seen, completed + pending.length);
    }

    function stop() {
      cancelled = true;
      pending.length = 0;
      releaseObserver();
    }

    /* ---------- one item's worth of request ---------- */

    /* The string we would send if nothing were protected. This is what the
       cache is keyed on, so a cache hit does not depend on whether the
       glossary happened to match this time. */
    function sourceTextFor(item) {
      if (item.kind !== 'segment') return item.text;
      const segment = item.segment;
      return segment.texts.length === 1
        ? segment.texts[0]
        : segmenter.buildJoined(segment.texts, item.markerStyle);
    }

    function keyFor(item, text) {
      return hash.cacheKey(text, source, target, cacheSalt);
    }

    /* ---------- writing a result back ---------- */

    /* Returns the text that actually went into the page, or null when the
       item was re-queued to be tried a different way.

       The return value is what gets cached, and it has to be the restored
       text rather than the model's raw output: a protected sentence comes
       back with "{{G0}}" still in it, and caching that would serve the
       placeholder straight into the page on the next load, where nothing
       knows to undo it any more. */
    function applyResult(item, raw, guard) {
      let translated = raw;

      if (guard && guard.found.length) {
        translated = HUEN.glossary.restore(raw, guard.found);
        if (translated === null) {
          /* The model ate a placeholder. A sentence with "{{G0}}" sitting in
             the middle of it is worse than one where the brand name got
             translated, so ask again without protection. */
          applier.markGlossaryRetry();
          push(Object.assign({}, item, { protect: false }));
          return null;
        }
      }

      if (item.kind === 'attr') {
        applier.setAttr(item.el, item.attr, translated);
        return translated;
      }
      if (item.kind === 'node') {
        applier.setText(item.node, translated);
        return translated;
      }

      const segment = item.segment;
      if (segment.texts.length === 1) {
        applier.setText(segment.nodes[0], translated);
        return translated;
      }

      const parts = segmenter.splitJoined(translated, segment.texts.length, item.markerStyle);
      if (parts) {
        applier.applySegment(segment, parts);
        return translated;
      }

      // The markers did not survive. Try the other syntax before giving up on
      // keeping the sentence whole.
      const nextStyle = item.markerStyle + 1;
      if (nextStyle < segmenter.STYLES.length) {
        applier.markMarkerRetry();
        push(Object.assign({}, item, { markerStyle: nextStyle }));
        return null;
      }

      /* Out of syntaxes. Translate each node on its own: the wording suffers,
         because the model now sees fragments, but the output is never
         garbled and the markup stays where it belongs. */
      applier.markFallback();
      for (let i = 0; i < segment.nodes.length; i++) {
        if (!lang.isTranslatable(segment.texts[i])) continue;
        if (glossary.isExactTerm(segment.texts[i])) continue;
        push({ kind: 'node', node: segment.nodes[i], text: segment.texts[i], protect: true });
      }
      return null;
    }

    /* ---------- picking the next batch ---------- */

    function takeBatch() {
      if (!pending.length) return [];
      const near = [];
      const far = [];
      for (const item of pending) {
        const element = itemElement(item);
        (element && nearViewport.has(element) ? near : far).push(item);
      }
      pending.length = 0;

      const batch = near.splice(0, BATCH_SIZE);
      if (batch.length < BATCH_SIZE) {
        batch.push.apply(batch, far.splice(0, BATCH_SIZE - batch.length));
      }
      pending.push.apply(pending, near);
      pending.push.apply(pending, far);
      return batch;
    }

    function idle() {
      return new Promise(function (resolve) {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(function () { resolve(); }, { timeout: 150 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    }

    /* ---------- the long way round: streaming ---------- */

    function isStreamable(item, text) {
      return typeof transport.translateLong === 'function' &&
        item.kind === 'segment' &&
        item.segment.texts.length === 1 &&
        text.length >= STREAM_MIN;
    }

    /* One long block, written into the page as it arrives. */
    async function runStreaming(item, request, guard, key) {
      const node = item.segment.nodes[0];
      let result;
      try {
        result = await transport.translateLong(request, function (partial) {
          // Unprotected text only: a half-finished placeholder on screen would
          // look like a bug to the reader.
          if (!guard.found.length) applier.previewText(node, partial);
        });
      } catch (err) {
        onError(err);
        return null;
      }
      if (cancelled) return null;
      if (!result || !result.ok) return result || null;
      const written = applyResult(item, result.text, guard);
      return written === null ? null : { key, text: written };
    }

    /* ---------- the loop ---------- */

    async function run() {
      if (running) return;
      running = true;
      try {
        /* Give the observer one chance to report before the first batch, so
           the page does not start translating from the top while the reader is
           looking at the middle. */
        if (firstFlush) {
          const flush = firstFlush;
          firstFlush = null;
          await Promise.race([flush, new Promise(function (r) { setTimeout(r, FIRST_FLUSH_MS); })]);
          if (cancelled) return;
        }

        while (pending.length && !cancelled) {
          const batch = takeBatch();
          if (!batch.length) break;

          const requests = batch.map(function (item) {
            const plain = sourceTextFor(item);
            const guard = item.protect ? glossary.protect(plain) : { text: plain, found: [] };
            return { item, plain, guard, key: keyFor(item, plain) };
          });

          let hits = {};
          try {
            hits = await transport.cacheGet(requests.map(function (r) { return r.key; }));
          } catch (_) {
            hits = {};
          }
          if (cancelled) return;

          const misses = [];
          for (const request of requests) {
            const cached = hits[request.key];
            if (typeof cached === 'string' && cached) {
              // A cached value is already restored and already split-checked.
              applyResult(request.item, cached, null);
            } else {
              misses.push(request);
            }
          }

          const fresh = [];
          const batched = [];

          for (const request of misses) {
            if (isStreamable(request.item, request.guard.text)) {
              const written = await runStreaming(
                request.item, request.guard.text, request.guard, request.key);
              if (cancelled) return;
              if (written) fresh.push([written.key, written.text]);
            } else {
              batched.push(request);
            }
          }

          if (batched.length) {
            let results;
            try {
              results = await transport.translate(
                batched.map(function (r) { return r.guard.text; }));
            } catch (err) {
              onError(err);
              return;
            }
            if (cancelled) return;

            for (let i = 0; i < batched.length; i++) {
              const result = results[i];
              if (!result) continue;
              if (result.ok) {
                const written = applyResult(
                  batched[i].item, result.text, batched[i].guard);
                if (written !== null) fresh.push([batched[i].key, written]);
              } else if (isFatalCode(result.code)) {
                // No model, no gesture, no such pair: retrying other strings
                // cannot help, so stop and let the caller surface it.
                onError(Object.assign(new Error(result.error), { code: result.code }));
                return;
              }
              // Any other failure is this one string's problem. Leave it in
              // the original language and carry on with the rest of the page.
            }
          }

          if (fresh.length) transport.cachePut(fresh).catch(function () {});

          completed += batch.length;
          seen = Math.max(seen, completed + pending.length);
          onProgress({ completed, total: seen, stats: applier.stats });

          await idle(); // keep scrolling and rendering smooth
        }
      } finally {
        running = false;
        if (!pending.length) releaseObserver();
      }
      if (pending.length && !cancelled) run();
    }

    return {
      addFromCollection,
      run,
      stop,
      get size() { return pending.length; },
      get isRunning() { return running; },
      get progress() { return { completed, total: seen }; },
    };
  }

  HUEN.createQueue = createQueue;
})(globalThis.HUEN);
