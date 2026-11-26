/* Tag classification used by the segmenter and by the page-language sample. */
(function (HUEN) {
  'use strict';

  /* Never descend into these: code, machine-readable content, media, and
     anything the user types into. Translating the contents of a <code> block or
     a <textarea> would be actively destructive, not merely unhelpful. */
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'SVG', 'CANVAS', 'MATH', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT',
    'EMBED', 'VIDEO', 'AUDIO', 'MAP', 'AREA', 'TRACK', 'SOURCE', 'PARAM',
    'DATALIST', 'PROGRESS', 'METER', 'HEAD', 'LINK', 'META', 'TITLE',
  ]);

  /* Boundaries for a translation unit. Text inside one of these, excluding
     nested blocks, is translated together as a sentence. */
  const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BUTTON', 'CAPTION',
    'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
    'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
    'HGROUP', 'HR', 'LABEL', 'LEGEND', 'LI', 'MAIN', 'NAV', 'OL', 'OPTGROUP',
    'OPTION', 'P', 'SECTION', 'SELECT', 'SUMMARY', 'TABLE', 'TBODY', 'TD',
    'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ]);

  /* Attributes whose values are shown to the user, so they need translating. */
  const ATTRS = [
    'title', 'alt', 'placeholder', 'aria-label',
    'aria-placeholder', 'aria-roledescription',
  ];

  /* input/button value text is user-visible only for these types. */
  const VALUE_TYPES = new Set(['button', 'submit', 'reset']);

  function isSkipped(el) {
    if (SKIP.has(el.tagName)) return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    // Our own injected UI, so a banner never translates itself.
    if (el.classList.contains('huen-ui')) return true;
    // Cheap inline-style check; getComputedStyle on every element is too slow
    // to run over a whole page, and this catches the common case.
    const style = el.getAttribute('style');
    if (style && /display\s*:\s*none/i.test(style)) return true;
    return false;
  }

  /* Walk up from a node and report whether anything above it is off limits.

     Needed for the incremental path: a MutationObserver hands us a single text
     node or element, with no record of the ancestors we would have refused to
     descend through had we started at the document root. Without this check, a
     script that rewrites its own <script> body or a user typing in a
     contenteditable would get their text "translated". */
  function isInSkippedTree(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      if (el.nodeType === 1 && isSkipped(el)) return true;
      el = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    }
    return false;
  }

  function isBlock(el) {
    return BLOCK.has(el.tagName);
  }

  HUEN.tags = { SKIP, BLOCK, ATTRS, VALUE_TYPES, isSkipped, isInSkippedTree, isBlock };
})(globalThis.HUEN);
