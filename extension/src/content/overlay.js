/* Everything this extension draws on top of somebody else's page: the prompt
   that asks for the one click Chrome needs before it will fetch a language
   model, and the tooltip that shows the Hungarian behind a translated phrase.

   It all lives in a shadow root. Host pages have aggressive global styles,
   `!important` resets and z-index wars, and the previous approach — `all:
   initial` on every rule in a page-level stylesheet — still lost to pages that
   set `div { font-family: ... !important }`. A shadow root ends that whole
   category of bug: nothing inherits in, and our class names cannot collide
   with the page's. */
(function (HUEN) {
  'use strict';

  const STYLE = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; margin: 0; font: inherit; color: inherit; }',

    '.layer {',
    '  position: fixed;',
    '  inset: 0 0 auto auto;',
    '  z-index: 2147483600;',
    '  padding: 14px;',
    '  font-family: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", sans-serif;',
    '  font-size: 13px;',
    '  line-height: 1.45;',
    '  -webkit-font-smoothing: antialiased;',
    '  pointer-events: none;',
    '}',

    '.card {',
    '  pointer-events: auto;',
    '  position: relative;',
    '  overflow: hidden;',
    '  width: 336px;',
    '  max-width: calc(100vw - 28px);',
    '  padding: 13px 14px 14px;',
    '  color: #23201b;',
    '  background: #fffefb;',
    '  border: 1px solid #ded8cd;',
    '  border-radius: 10px;',
    '  box-shadow: 0 1px 1px rgba(35,32,27,.05), 0 4px 10px rgba(35,32,27,.07), 0 14px 34px rgba(35,32,27,.11);',
    '  animation: rise 220ms cubic-bezier(.22,.68,.2,1) both;',
    '}',

    '@keyframes rise {',
    '  from { opacity: 0; transform: translateY(-7px) scale(.985); }',
    '  to { opacity: 1; transform: none; }',
    '}',

    '@media (prefers-reduced-motion: reduce) { .card { animation: none; } }',

    '.eyebrow {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  margin-bottom: 7px;',
    '  font-size: 10px;',
    '  font-weight: 600;',
    '  letter-spacing: .08em;',
    '  text-transform: uppercase;',
    '  color: #857d6e;',
    '}',

    '.eyebrow::before {',
    '  content: "";',
    '  width: 6px;',
    '  height: 6px;',
    '  border-radius: 50%;',
    '  background: #2f6b4f;',
    '}',

    '.card--error .eyebrow::before { background: #b3261e; }',

    '.text { padding-right: 18px; }',

    '.row { display: flex; align-items: center; gap: 9px; margin-top: 12px; }',

    '.btn {',
    '  flex: 0 0 auto;',
    '  padding: 6px 13px;',
    '  font-size: 12.5px;',
    '  font-weight: 550;',
    '  color: #fffefb;',
    '  background: #2f6b4f;',
    '  border: 1px solid #295e45;',
    '  border-radius: 7px;',
    '  cursor: pointer;',
    '  transition: background 120ms ease;',
    '}',

    '.btn:hover { background: #285d44; }',
    '.btn:active { background: #224f3a; }',
    '.btn:focus-visible { outline: 2px solid #2f6b4f; outline-offset: 2px; }',
    '.btn[disabled] { color: #f3f0e9; background: #9bada2; border-color: #9bada2; cursor: default; }',

    '.ghost {',
    '  flex: 0 0 auto;',
    '  padding: 6px 4px;',
    '  font-size: 12.5px;',
    '  color: #6f6759;',
    '  background: none;',
    '  border: 0;',
    '  cursor: pointer;',
    '}',

    '.ghost:hover { color: #23201b; }',

    '.close {',
    '  position: absolute;',
    '  top: 8px;',
    '  right: 8px;',
    '  width: 22px;',
    '  height: 22px;',
    '  font-size: 15px;',
    '  line-height: 1;',
    '  color: #a1988a;',
    '  background: none;',
    '  border: 0;',
    '  border-radius: 5px;',
    '  cursor: pointer;',
    '}',

    '.close:hover { color: #23201b; background: #f1ece2; }',

    '.meter { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: #ebe5d9; }',
    '.meter span { display: block; height: 100%; width: 0; background: #2f6b4f; transition: width 180ms ease; }',

    /* Fixed, not absolute: the .layer above is shrink-wrapped against the top
       right corner, so an absolutely positioned tooltip would resolve its
       offsets against that little box instead of the viewport and land next to
       the card no matter what the reader was pointing at. */
    '.tip {',
    '  pointer-events: none;',
    '  position: fixed;',
    '  z-index: 2147483601;',
    '  display: flex;',
    '  gap: 7px;',
    '  max-width: 360px;',
    '  padding: 7px 9px;',
    '  font-size: 12px;',
    '  line-height: 1.45;',
    '  color: #f6f3ec;',
    '  background: #211e19;',
    '  border-radius: 7px;',
    '  box-shadow: 0 6px 20px rgba(33,30,25,.28);',
    '  white-space: pre-wrap;',
    '  opacity: 0;',
    '  transition: opacity 90ms ease;',
    '}',

    '.tip--on { opacity: 1; }',

    '.tip b {',
    '  flex: 0 0 auto;',
    '  align-self: flex-start;',
    '  padding: 1px 4px;',
    '  font-size: 9px;',
    '  font-weight: 600;',
    '  letter-spacing: .06em;',
    '  color: #c8bfab;',
    '  border: 1px solid #4a4439;',
    '  border-radius: 3px;',
    '}',

    '@media (prefers-color-scheme: dark) {',
    '  .card {',
    '    color: #ece7dd;',
    '    background: #221f1b;',
    '    border-color: #3b362e;',
    '    box-shadow: 0 2px 6px rgba(0,0,0,.3), 0 16px 38px rgba(0,0,0,.45);',
    '  }',
    '  .eyebrow { color: #9c9281; }',
    '  .ghost { color: #a79d8b; }',
    '  .ghost:hover { color: #ece7dd; }',
    '  .close { color: #867c6c; }',
    '  .close:hover { color: #ece7dd; background: #2f2b24; }',
    '  .meter { background: #332e27; }',
    '  .tip { color: #211e19; background: #efebe1; }',
    '  .tip b { color: #6f6759; border-color: #c3bba9; }',
    '}',
  ].join('\n');

  let layer = null;
  let card = null;
  let tip = null;

  function mount() {
    if (layer && layer.isConnected) return true;
    if (!document.documentElement) return false;

    const host = document.createElement('div');
    // The segmenter refuses anything carrying this class, so our own prompt can
    // never end up translating itself.
    host.className = 'huen-ui';
    host.setAttribute('aria-live', 'polite');
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    layer = document.createElement('div');
    layer.className = 'layer';
    shadow.appendChild(layer);

    document.documentElement.appendChild(host);
    return true;
  }

  /* ---------- the prompt card ---------- */

  function dismiss() {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  /* spec = { tone, eyebrow, text, action: { label, onClick },
              secondary: { label, onClick } } */
  function showCard(spec) {
    if (!mount()) return;
    dismiss();

    card = document.createElement('div');
    card.className = 'card' + (spec.tone === 'error' ? ' card--error' : '');
    card.setAttribute('role', spec.tone === 'error' ? 'alert' : 'status');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = spec.eyebrow || 'Hungarian page';
    card.appendChild(eyebrow);

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = spec.text;
    card.appendChild(text);

    if (spec.action) {
      const row = document.createElement('div');
      row.className = 'row';

      const button = document.createElement('button');
      button.className = 'btn';
      button.type = 'button';
      button.textContent = spec.action.label;
      button.addEventListener('click', function () {
        button.disabled = true;
        spec.action.onClick();
      });
      row.appendChild(button);

      if (spec.secondary) {
        const ghost = document.createElement('button');
        ghost.className = 'ghost';
        ghost.type = 'button';
        ghost.textContent = spec.secondary.label;
        ghost.addEventListener('click', spec.secondary.onClick);
        row.appendChild(ghost);
      }

      card.appendChild(row);
    }

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', dismiss);
    card.appendChild(close);

    layer.appendChild(card);
  }

  /* Replace the card's wording in place and turn the action row into a progress
     meter. Used once the download is under way: the click has happened, so
     offering the button again would be a lie. */
  function setCardProgress(text, fraction) {
    if (!card) return;
    const label = card.querySelector('.text');
    if (label) label.textContent = text;
    const row = card.querySelector('.row');
    if (row) row.remove();

    let meter = card.querySelector('.meter');
    if (!meter) {
      meter = document.createElement('div');
      meter.className = 'meter';
      meter.appendChild(document.createElement('span'));
      card.appendChild(meter);
    }
    if (typeof fraction === 'number') {
      meter.firstChild.style.width = Math.max(0, Math.min(100, fraction * 100)) + '%';
    }
  }

  function hasCard() {
    return !!card;
  }

  /* ---------- the original-text tooltip ---------- */

  function hideTip() {
    if (!tip) return;
    const node = tip;
    tip = null;
    node.classList.remove('tip--on');
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 120);
  }

  function showTip(anchor, original, sourceCode) {
    if (!mount()) return;
    hideTip();

    tip = document.createElement('div');
    tip.className = 'tip';
    const chip = document.createElement('b');
    // The source is whatever the page turned out to be, not always Hungarian.
    chip.textContent = String(sourceCode || 'hu').slice(0, 7).toUpperCase();
    tip.appendChild(chip);
    tip.appendChild(document.createTextNode(original));
    layer.appendChild(tip);

    /* Viewport coordinates, clamped to the window rather than to the document:
       placing it in document coordinates is what made the old tooltip drift
       further off target the further down the page the reader had scrolled.
       It flips above the phrase when there is no room below. */
    const box = anchor.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;

    const below = box.bottom + 8;
    const top = below + height > viewportH - 8 ? Math.max(8, box.top - height - 8) : below;
    const left = Math.max(8, Math.min(box.left, viewportW - width - 8));

    tip.style.top = top + 'px';
    tip.style.left = left + 'px';

    const node = tip;
    requestAnimationFrame(function () { node.classList.add('tip--on'); });
  }

  function teardown() {
    dismiss();
    hideTip();
  }

  HUEN.overlay = {
    showCard,
    setCardProgress,
    dismiss,
    hasCard,
    showTip,
    hideTip,
    teardown,
  };
})(globalThis.HUEN);
