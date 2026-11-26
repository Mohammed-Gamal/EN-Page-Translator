/* Turns a DOM subtree into translation units ("segments").

   A segment is the run of text nodes inside one block-level element.

   Grouping is what makes the output readable. "A <b>kutya</b> fut a kertben"
   is three separate text nodes; translating them one at a time hands the model
   three meaningless fragments. Translated as one string it yields a correct
   English sentence, and the marker protocol below redistributes the pieces into
   the original nodes so bold text and links survive intact. */
(function (HUEN) {
  'use strict';

  const { tags, lang } = HUEN;

  /* Two marker syntaxes, tried in order.

     Which tokens a translation model carries through unchanged is not
     something you can reason about from the outside — it depends on the
     tokeniser, and it varies by sentence. `{1}` survives most of the time;
     when it does not, `[[1]]` often does, and vice versa. Trying the second
     syntax costs one more call on a segment that was going to be split up
     node-by-node anyway, which is the outcome we are trying to avoid.

     Both parsers fail closed: anything other than exactly the expected markers
     in exactly the expected order returns null. */
  const STYLES = [
    { open: '{', close: '}', re: /\{(\d{1,3})\}/g },
    { open: '[[', close: ']]', re: /\[\[(\d{1,3})\]\]/g },
  ];

  function styleAt(index) {
    return STYLES[index] || STYLES[0];
  }

  function buildJoined(texts, styleIndex) {
    const style = styleAt(styleIndex);
    let out = '';
    for (let i = 0; i < texts.length; i++) {
      out += style.open + (i + 1) + style.close + ' ' + texts[i] + ' ';
    }
    return out.trim();
  }

  /* Reverse of buildJoined. Returns an array of strings, or null when the model
     dropped, duplicated or reordered the markers, in which case the caller
     either retries with the next syntax or translates each node on its own. */
  function splitJoined(translated, count, styleIndex) {
    const style = styleAt(styleIndex);
    const found = [];
    style.re.lastIndex = 0;
    let match;
    while ((match = style.re.exec(translated)) !== null) {
      found.push({
        index: Number(match[1]),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    if (found.length !== count) return null;
    for (let i = 0; i < count; i++) {
      // Out of order means the model moved a clause across a markup boundary.
      // We cannot reorder DOM nodes, so this segment needs the fallback.
      if (found[i].index !== i + 1) return null;
    }
    const parts = [];
    for (let i = 0; i < count; i++) {
      const from = found[i].end;
      const to = i + 1 < count ? found[i + 1].start : translated.length;
      parts.push(translated.slice(from, to).trim());
    }
    return parts;
  }

  /* Collect segments and translatable attributes under `root`.
     `isDone(nodeOrEl, attrName)` lets the caller skip what it already did. */
  function collect(root, isDone) {
    const segments = [];
    const attrs = [];
    const done = typeof isDone === 'function' ? isDone : function () { return false; };

    function pushSegment(container, nodes) {
      if (!nodes.length) return;
      const texts = [];
      const kept = [];
      for (const node of nodes) {
        const t = node.data.replace(/\s+/g, ' ').trim();
        if (!t) continue;
        kept.push(node);
        texts.push(t);
      }
      if (!kept.length) return;
      // Only send the segment if at least one piece is real prose.
      let worth = false;
      for (const t of texts) {
        if (lang.isTranslatable(t)) { worth = true; break; }
      }
      if (!worth) return;
      segments.push({ container, nodes: kept, texts });
    }

    function collectAttrs(el) {
      for (const name of tags.ATTRS) {
        if (!el.hasAttribute(name)) continue;
        const raw = el.getAttribute(name);
        if (!raw) continue;
        const t = raw.replace(/\s+/g, ' ').trim();
        if (!t || !lang.isTranslatable(t)) continue;
        if (done(el, name)) continue;
        attrs.push({ el, attr: name, text: t });
      }
      if (el.tagName === 'INPUT' || el.tagName === 'BUTTON') {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (tags.VALUE_TYPES.has(type) && el.hasAttribute('value')) {
          const t = (el.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
          if (t && lang.isTranslatable(t) && !done(el, 'value')) {
            attrs.push({ el, attr: 'value', text: t });
          }
        }
      }
    }

    function visit(node, bucket) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (!child.data || !child.data.trim()) continue;
          if (done(child)) continue;
          bucket.push(child);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (tags.isSkipped(child)) continue;

        collectAttrs(child);

        // An open shadow root is its own tree; treat it as a block boundary.
        if (child.shadowRoot) {
          const shadowBucket = [];
          visit(child.shadowRoot, shadowBucket);
          pushSegment(child.shadowRoot, shadowBucket);
        }

        if (tags.isBlock(child)) {
          const nested = [];
          visit(child, nested);
          pushSegment(child, nested);
        } else {
          visit(child, bucket); // inline: stays in the same sentence
        }
      }
    }

    /* `root` is often a single node handed over by the MutationObserver rather
       than the document body, so the ancestors we would have refused to
       descend through were never examined. Check them explicitly: without
       this, a script rewriting its own <script> text, or a user typing into a
       contenteditable, ends up "translated". */
    if (tags.isInSkippedTree(root)) return { segments, attrs };

    if (root.nodeType === Node.TEXT_NODE) {
      if (root.data && root.data.trim() && !done(root)) {
        pushSegment(root.parentElement || root, [root]);
      }
      return { segments, attrs };
    }
    if (root.nodeType === Node.ELEMENT_NODE) {
      collectAttrs(root);
    }

    const top = [];
    visit(root, top);
    pushSegment(root, top);

    return { segments, attrs };
  }

  HUEN.segmenter = { collect, buildJoined, splitJoined, STYLES };
})(globalThis.HUEN);
