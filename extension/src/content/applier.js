/* Writes translations into the DOM, remembers the Hungarian original, and puts
   everything back on request.

   On re-entrancy: our own writes do generate MutationObserver records, and the
   guard against re-translating them is `isDone()`, not a "we are writing now"
   flag. Mutation records are delivered in a microtask, long after any
   synchronous flag would have been cleared, so the flag this file used to carry
   was always false by the time anything read it. The markers below are the real
   mechanism:

     - a text node we wrote is in `doneNodes`
     - an attribute we wrote is in `doneAttrs`
     - `data-huen-src` and `class` are not in the observer's attributeFilter
     - the <title> write lands inside <title>, which the segmenter refuses */
(function (HUEN) {
  'use strict';

  /* Reassigned wholesale by restoreAll(), which is why these are `let`: a
     WeakSet cannot be emptied, and leaving the done-markers in place after a
     restore meant the segmenter refused every node it had already touched.
     "Show original" followed by "Translate page" then did nothing at all. */
  let originalText = new WeakMap();  // text node -> original string
  let originalAttr = new WeakMap();  // element -> Map(attr -> original value)
  let doneNodes = new WeakSet();
  let doneAttrs = new WeakMap();     // element -> Set(attr)

  /* Strong references, so restore() can walk back over everything it touched.
     A long-lived single-page app churns nodes, so these are pruned of detached
     entries once they grow past the point where pruning is worth the scan. */
  const touchedNodes = [];
  const touchedAttrs = [];
  const markedHosts = [];              // elements carrying data-huen-src
  const PRUNE_AT = 4000;

  const stats = {
    segments: 0,
    nodes: 0,
    attrs: 0,
    chars: 0,
    /* Diagnostics for the marker protocol. `markerRetries` is a segment the
       first syntax lost and the second one was tried on; `fallbacks` is a
       segment that ran out of syntaxes and had to be translated node by node;
       `glossaryRetries` is a sentence resent without protection. All three
       being zero on a site means the protocols are holding. */
    markerRetries: 0,
    glossaryRetries: 0,
    fallbacks: 0,
  };

  function prune(list, nodeOf) {
    if (list.length < PRUNE_AT) return;
    const live = list.filter(function (item) {
      const node = nodeOf(item);
      return node && node.isConnected !== false;
    });
    list.length = 0;
    list.push.apply(list, live);
  }

  const identity = function (x) { return x; };
  const elementOf = function (x) { return x.el; };

  function isDone(nodeOrEl, attr) {
    if (attr) {
      const set = doneAttrs.get(nodeOrEl);
      return !!(set && set.has(attr));
    }
    return doneNodes.has(nodeOrEl);
  }

  /* Keep the original node's outer whitespace. "A " + <b>kutya</b> must not
     become "A" + <b>dog</b> and glue the two words together. */
  function reclothe(original, translated) {
    return (/^\s/.test(original) ? ' ' : '') + translated +
      (/\s$/.test(original) ? ' ' : '');
  }

  /* Record the original text on the nearest element so the hover tooltip has
     something to show. One element only carries the first segment it saw,
     which is what the user is pointing at in practice. */
  function markOriginal(node) {
    const host = node.parentElement;
    if (!host || host.hasAttribute('data-huen-src')) return;
    const source = (originalText.get(node) || '').trim();
    if (!source) return;
    host.setAttribute('data-huen-src', source.slice(0, 400));
    host.classList.add('huen-translated');
    markedHosts.push(host);
    prune(markedHosts, identity);
  }

  function setText(node, translated) {
    if (!translated) return false;
    const original = node.data;
    if (!originalText.has(node)) originalText.set(node, original);
    node.data = reclothe(original, translated);
    doneNodes.add(node);
    touchedNodes.push(node);
    prune(touchedNodes, identity);
    stats.nodes++;
    stats.chars += translated.length;
    markOriginal(node);
    return true;
  }

  function setAttr(el, attr, translated) {
    if (!translated) return false;
    let originals = originalAttr.get(el);
    if (!originals) {
      originals = new Map();
      originalAttr.set(el, originals);
    }
    if (!originals.has(attr)) originals.set(attr, el.getAttribute(attr));
    el.setAttribute(attr, translated);

    let done = doneAttrs.get(el);
    if (!done) {
      done = new Set();
      doneAttrs.set(el, done);
    }
    done.add(attr);

    touchedAttrs.push({ el, attr });
    prune(touchedAttrs, elementOf);
    stats.attrs++;
    stats.chars += translated.length;
    return true;
  }

  /* Apply a whole segment from one joined translation. `parts` lines up with
     `segment.nodes`; the caller passes null when the marker round-trip failed
     and it is re-queueing the nodes individually instead. */
  function applySegment(segment, parts) {
    if (!parts) return false;
    const count = Math.min(parts.length, segment.nodes.length);
    let wrote = false;
    for (let i = 0; i < count; i++) {
      if (setText(segment.nodes[i], parts[i])) wrote = true;
    }
    if (wrote) stats.segments++;
    return wrote;
  }

  function markFallback() {
    stats.fallbacks++;
  }

  function markMarkerRetry() {
    stats.markerRetries++;
  }

  function markGlossaryRetry() {
    stats.glossaryRetries++;
  }

  /* A partial result from a streamed translation. Records the original the
     first time, then just updates the text: no done-marking and no statistics,
     because the segment is not finished and setText() will do all of that when
     the stream closes. */
  function previewText(node, partial) {
    if (!partial) return;
    if (!originalText.has(node)) originalText.set(node, node.data);
    try {
      node.data = reclothe(originalText.get(node), partial);
    } catch (_) { /* node detached mid-stream */ }
  }

  function resetStats() {
    stats.segments = 0;
    stats.nodes = 0;
    stats.attrs = 0;
    stats.chars = 0;
    stats.markerRetries = 0;
    stats.glossaryRetries = 0;
    stats.fallbacks = 0;
  }

  function restoreAll() {
    for (const node of touchedNodes) {
      if (!originalText.has(node)) continue;
      try {
        node.data = originalText.get(node);
      } catch (_) { /* node detached from the document */ }
    }
    for (const item of touchedAttrs) {
      const originals = originalAttr.get(item.el);
      if (!originals || !originals.has(item.attr)) continue;
      const value = originals.get(item.attr);
      try {
        if (value === null) item.el.removeAttribute(item.attr);
        else item.el.setAttribute(item.attr, value);
      } catch (_) { /* element detached */ }
    }
    /* Tracked rather than queried: document.querySelectorAll cannot see into
       shadow roots, so a query-based cleanup left marker attributes behind on
       every custom element we had translated. */
    for (const host of markedHosts) {
      try {
        host.removeAttribute('data-huen-src');
        host.classList.remove('huen-translated');
      } catch (_) { /* element detached */ }
    }
    touchedNodes.length = 0;
    touchedAttrs.length = 0;
    markedHosts.length = 0;
    originalText = new WeakMap();
    originalAttr = new WeakMap();
    doneNodes = new WeakSet();
    doneAttrs = new WeakMap();
    resetStats();
  }

  HUEN.applier = {
    isDone,
    setText,
    setAttr,
    previewText,
    applySegment,
    markFallback,
    markMarkerRetry,
    markGlossaryRetry,
    restoreAll,
    stats,
  };
})(globalThis.HUEN);
