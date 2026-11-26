/* Tests for the DOM walker in segmenter.collect().

   No jsdom here, so this file ships a minimal DOM shim implementing exactly the
   surface the segmenter touches: nodeType, firstChild/nextSibling, data,
   tagName, the attribute accessors, classList.contains, isContentEditable and
   shadowRoot. Keeping the shim small is deliberate — if the segmenter ever
   starts relying on something else, these tests fail loudly rather than
   silently passing against a fake. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'extension', 'src');

/* ---------- minimal DOM ---------- */

class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.nextSibling = null;
    this.parentElement = null;
    this.isConnected = true;
  }
}

class Element {
  constructor(tag, attrs) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs || {}));
    this.childNodes = [];
    this.firstChild = null;
    this.nextSibling = null;
    this.parentElement = null;
    this.shadowRoot = null;
    this.isContentEditable = false;
    this.isConnected = true;
  }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  get classList() {
    const self = this;
    const read = () => String(self.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    return {
      contains: (c) => read().indexOf(c) !== -1,
      add(c) {
        const cls = read();
        if (cls.indexOf(c) === -1) cls.push(c);
        self.setAttribute('class', cls.join(' '));
      },
      remove(c) {
        self.setAttribute('class', read().filter((x) => x !== c).join(' '));
      },
    };
  }
  append(...kids) {
    for (const kid of kids) {
      const node = typeof kid === 'string' ? new TextNode(kid) : kid;
      node.parentElement = this;
      if (this.childNodes.length) {
        this.childNodes[this.childNodes.length - 1].nextSibling = node;
      }
      this.childNodes.push(node);
      this.firstChild = this.childNodes[0];
    }
    return this;
  }
}

function el(tag, attrs, ...kids) {
  return new Element(tag, attrs).append(...kids);
}

/* ---------- load the extension code into a sandbox with that DOM ---------- */

function loadHUEN() {
  const sandbox = { console, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of [
    'shared/namespace.js', 'shared/protocol.js', 'shared/settings.js',
    'shared/languages.js', 'shared/lang.js', 'shared/hash.js', 'shared/glossary.js',
    'content/tags.js', 'content/segmenter.js', 'content/applier.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'),
      sandbox, { filename: file });
  }
  return sandbox.HUEN;
}

const HUEN = loadHUEN();
const collect = (root) => HUEN.segmenter.collect(root, () => false);

/* ---------- tests ---------- */

test('a sentence broken by inline markup stays one segment', () => {
  // A <b>kutya</b> fut a kertben  ->  three text nodes, one sentence.
  const root = el('div', null,
    el('p', null, 'A ', el('b', null, 'kutya'), ' fut a kertben'));

  const { segments } = collect(root);
  assert.strictEqual(segments.length, 1, 'inline markup must not split the sentence');
  assert.deepStrictEqual(Array.from(segments[0].texts), ['A', 'kutya', 'fut a kertben']);
});

test('a link inside a sentence stays in the same segment', () => {
  const root = el('p', null,
    'Olvassa el az ', el('a', { href: '/x' }, 'adatvédelmi tájékoztatót'), ' figyelmesen');

  const { segments } = collect(root);
  assert.strictEqual(segments.length, 1);
  assert.strictEqual(segments[0].nodes.length, 3);
});

test('separate block elements become separate segments', () => {
  const root = el('div', null,
    el('p', null, 'Első bekezdés a lapon'),
    el('p', null, 'Második bekezdés a lapon'));

  const { segments } = collect(root);
  assert.strictEqual(segments.length, 2);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['Első bekezdés a lapon']);
  assert.deepStrictEqual(Array.from(segments[1].texts), ['Második bekezdés a lapon']);
});

test('list items are separate segments', () => {
  const root = el('ul', null,
    el('li', null, 'Regisztráljon a rendszerben'),
    el('li', null, 'Töltse ki az adatlapot'),
    el('li', null, 'Küldje be a kérelmet'));

  assert.strictEqual(collect(root).segments.length, 3);
});

test('script, style, pre and textarea content is never collected', () => {
  const root = el('div', null,
    el('script', null, 'var üzenet = "nem fordítandó";'),
    el('style', null, '.a { color: red }'),
    el('pre', null, el('code', null, 'const x = "magyar szöveg";')),
    el('textarea', null, 'Felhasználói szöveg itt'),
    el('p', null, 'Ezt viszont le kell fordítani'));

  const { segments } = collect(root);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['Ezt viszont le kell fordítani']);
});

test('translate="no", .notranslate, [hidden] and aria-hidden are respected', () => {
  const root = el('div', null,
    el('p', { translate: 'no' }, 'Ez maradjon magyarul'),
    el('p', { class: 'notranslate' }, 'Ez is maradjon magyarul'),
    el('p', { hidden: '' }, 'Rejtett bekezdés szövege'),
    el('p', { 'aria-hidden': 'true' }, 'Akadálymentesen rejtett szöveg'),
    el('p', null, 'Ezt kell lefordítani'));

  const { segments } = collect(root);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['Ezt kell lefordítani']);
});

test('contenteditable regions are left alone', () => {
  const editable = el('div', null, 'A felhasználó által írt szöveg');
  editable.isContentEditable = true;
  const root = el('div', null, editable, el('p', null, 'Normál bekezdés szövege'));

  assert.strictEqual(collect(root).segments.length, 1);
});

test('user-visible attributes are collected', () => {
  const root = el('div', null,
    el('img', { alt: 'Egy piros autó az utcán', title: 'Kattintson a nagyításhoz', src: 'a.png' }),
    el('input', { type: 'text', placeholder: 'Írja be a nevét', 'aria-label': 'Teljes név' }),
    el('input', { type: 'submit', value: 'Elküldés' }));

  const { attrs } = collect(root);
  // Array.from: the sandbox is a separate realm, so its arrays do not share
  // the host Array.prototype and deepStrictEqual would reject them.
  const pairs = Array.from(attrs, (a) => a.attr + '=' + a.text).sort();
  assert.deepStrictEqual(pairs, [
    'alt=Egy piros autó az utcán',
    'aria-label=Teljes név',
    'placeholder=Írja be a nevét',
    'title=Kattintson a nagyításhoz',
    'value=Elküldés',
  ]);
});

test('value is only collected for button-like inputs', () => {
  const root = el('div', null,
    el('input', { type: 'text', value: 'Beírt felhasználói érték' }),
    el('input', { type: 'hidden', value: 'Rejtett mező értéke' }));

  assert.strictEqual(collect(root).attrs.length, 0);
});

test('shadow roots are traversed', () => {
  const hostEl = el('div', null);
  hostEl.shadowRoot = el('div', null, el('p', null, 'Árnyék gyökérben lévő szöveg'));
  const root = el('div', null, hostEl, el('p', null, 'Rendes szöveg a lapon'));

  const texts = collect(root).segments.map((s) => s.texts.join(' '));
  assert.ok(texts.includes('Árnyék gyökérben lévő szöveg'), 'shadow DOM text must be found');
  assert.ok(texts.includes('Rendes szöveg a lapon'));
});

test('segments with no real words are dropped', () => {
  const root = el('div', null,
    el('p', null, '12 345 Ft'),
    el('p', null, '2024.03.15.'),
    el('span', null, '›'),
    el('p', null, 'Valódi magyar mondat itt'));

  const { segments } = collect(root);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['Valódi magyar mondat itt']);
});

test('whitespace is normalised but segments keep their node count', () => {
  const root = el('p', null, '  Sok    szóköz\n\tés tabulátor  ');
  const { segments } = collect(root);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['Sok szóköz és tabulátor']);
  assert.strictEqual(segments[0].nodes.length, 1);
});

test('isDone filtering excludes already translated nodes', () => {
  const first = new TextNode('Első bekezdés szövege');
  const root = el('div', null, el('p', null, first), el('p', null, 'Második bekezdés szövege'));

  const { segments } = HUEN.segmenter.collect(root, (node) => node === first);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['Második bekezdés szövege']);
});

test('a table is split into cell-level segments', () => {
  const root = el('table', null,
    el('thead', null, el('tr', null,
      el('th', null, 'Szolgáltatás'), el('th', null, 'Határidő'))),
    el('tbody', null, el('tr', null,
      el('td', null, 'Lakcímkártya igénylése'), el('td', null, '8 munkanap'))));

  const texts = collect(root).segments.map((s) => s.texts.join(' '));
  assert.ok(texts.includes('Szolgáltatás'));
  assert.ok(texts.includes('Határidő'));
  assert.ok(texts.includes('Lakcímkártya igénylése'));
  assert.ok(texts.includes('8 munkanap'));
});

/* ---------- the incremental path ---------- */

/* These cover what the MutationObserver hands over: a single node, with no
   record of the ancestors a walk from the document root would have refused to
   descend through. Before collect() checked upwards, a script rewriting its own
   <script> body got "translated". */

test('a text node handed over on its own refuses a skipped ancestor', () => {
  const inside = new TextNode('const felirat = "magyar szöveg";');
  const script = el('script', null, inside);
  el('div', null, script);

  assert.strictEqual(collect(inside).segments.length, 0);
});

test('a text node inside a contenteditable is refused on its own', () => {
  const typed = new TextNode('Amit a felhasználó éppen beír');
  const editable = el('div', null, typed);
  editable.isContentEditable = true;
  el('div', null, editable);

  assert.strictEqual(collect(typed).segments.length, 0);
});

test('a text node with no skipped ancestor is still collected', () => {
  const node = new TextNode('Rendes magyar bekezdés szövege');
  el('div', null, el('p', null, node));

  const { segments } = collect(node);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(Array.from(segments[0].texts),
    ['Rendes magyar bekezdés szövege']);
});

test('an element handed over on its own refuses a skipped ancestor', () => {
  const paragraph = el('p', null, 'Ez a bekezdés egy kódrészletben van');
  const pre = el('pre', null, paragraph);
  el('div', null, pre);

  assert.strictEqual(collect(paragraph).segments.length, 0);
});

test('translate="no" on an ancestor is honoured for a single node', () => {
  const node = new TextNode('Ezt a részt nem fordítjuk');
  el('div', { translate: 'no' }, el('span', null, node));

  assert.strictEqual(collect(node).segments.length, 0);
});

test('the extension refuses to translate its own injected UI', () => {
  const root = el('div', null,
    el('div', { class: 'huen-ui' }, el('p', null, 'Letöltés és fordítás')),
    el('p', null, 'A lap saját magyar szövege'));

  const { segments } = collect(root);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['A lap saját magyar szövege']);
});

test('a <time> element is translated now that dates read as prose', () => {
  // "2024. március 15." should come back as a readable English date.
  const root = el('p', null, el('time', { datetime: '2024-03-15' }, '2024. március 15.'));
  const texts = collect(root).segments.map((s) => s.texts.join(' '));
  assert.ok(texts.includes('2024. március 15.'));
});

/* ---------- applying and restoring ---------- */

const applier = HUEN.applier;

test('a translated node remembers its original and gives it back', () => {
  const node = new TextNode('Kapcsolat');
  el('p', null, node);

  applier.setText(node, 'Contact');
  assert.strictEqual(node.data, 'Contact');
  assert.strictEqual(node.parentElement.getAttribute('data-huen-src'), 'Kapcsolat');

  applier.restoreAll();
  assert.strictEqual(node.data, 'Kapcsolat');
  assert.strictEqual(node.parentElement.getAttribute('data-huen-src'), null);
});

test('surrounding whitespace survives translation', () => {
  // "A " + <b>kutya</b> must not become "A" + <b>dog</b>.
  const node = new TextNode(' a kertben ');
  el('p', null, node);
  applier.setText(node, 'in the garden');
  assert.strictEqual(node.data, ' in the garden ');
  applier.restoreAll();
});

test('restoring puts an attribute back, and removes one that was absent', () => {
  const img = el('img', { alt: 'Egy piros autó' });
  const input = el('input', { type: 'text' });

  applier.setAttr(img, 'alt', 'A red car');
  applier.setAttr(input, 'placeholder', 'Your name');
  assert.strictEqual(img.getAttribute('alt'), 'A red car');

  applier.restoreAll();
  assert.strictEqual(img.getAttribute('alt'), 'Egy piros autó');
  assert.strictEqual(input.getAttribute('placeholder'), null,
    'an attribute we invented must be removed, not left blank');
});

test('restoring clears the done markers so the page can be translated again', () => {
  // Regression: "Show original" followed by "Translate page" used to do
  // nothing, because every node was still marked as already translated and the
  // segmenter skipped all of it.
  const node = new TextNode('Bejelentkezés');
  const img = el('img', { alt: 'Egy piros autó' });
  el('div', null, el('p', null, node), img);

  applier.setText(node, 'Log in');
  applier.setAttr(img, 'alt', 'A red car');
  assert.ok(applier.isDone(node));
  assert.ok(applier.isDone(img, 'alt'));

  applier.restoreAll();
  assert.ok(!applier.isDone(node), 'the text node must be translatable again');
  assert.ok(!applier.isDone(img, 'alt'), 'the attribute must be translatable again');

  // And a fresh collect() now finds it rather than skipping it.
  const { segments } = HUEN.segmenter.collect(node.parentElement, applier.isDone);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(Array.from(segments[0].texts), ['Bejelentkezés']);
  applier.restoreAll();
});

test('statistics reset along with the page', () => {
  const node = new TextNode('Keresés');
  el('p', null, node);
  applier.setText(node, 'Search');
  assert.strictEqual(applier.stats.nodes, 1);
  assert.strictEqual(applier.stats.chars, 'Search'.length);

  applier.restoreAll();
  assert.strictEqual(applier.stats.nodes, 0);
  assert.strictEqual(applier.stats.chars, 0);
});

test('a segment is written back into its own nodes, in order', () => {
  const a = new TextNode('A');
  const b = new TextNode('kutya');
  const c = new TextNode('fut a kertben');
  el('p', null, a, el('b', null, b), c);

  const segment = { container: a.parentElement, nodes: [a, b, c], texts: ['A', 'kutya', 'fut a kertben'] };
  const parts = HUEN.segmenter.splitJoined('{1} The {2} dog {3} runs in the garden', 3);

  assert.ok(applier.applySegment(segment, Array.from(parts)));
  assert.strictEqual(a.data, 'The');
  assert.strictEqual(b.data, 'dog');
  assert.strictEqual(c.data, 'runs in the garden');
  applier.restoreAll();
});

test('a streamed partial is written without being marked finished', () => {
  const node = new TextNode('Egy hosszú magyar bekezdés szövege');
  el('p', null, node);

  applier.previewText(node, 'A long');
  assert.strictEqual(node.data, 'A long');
  assert.ok(!applier.isDone(node), 'a partial result is not a finished one');
  assert.strictEqual(applier.stats.nodes, 0, 'partials must not be counted');

  applier.previewText(node, 'A long Hungarian paragraph');
  assert.strictEqual(node.data, 'A long Hungarian paragraph');

  applier.setText(node, 'A long Hungarian paragraph of text');
  assert.ok(applier.isDone(node));
  assert.strictEqual(applier.stats.nodes, 1);

  applier.restoreAll();
  assert.strictEqual(node.data, 'Egy hosszú magyar bekezdés szövege',
    'the original must survive a stream that wrote over it several times');
});

test('the retry counters reset with everything else', () => {
  applier.markMarkerRetry();
  applier.markGlossaryRetry();
  applier.markFallback();
  assert.strictEqual(applier.stats.markerRetries, 1);
  assert.strictEqual(applier.stats.glossaryRetries, 1);
  assert.strictEqual(applier.stats.fallbacks, 1);

  applier.restoreAll();
  assert.strictEqual(applier.stats.markerRetries, 0);
  assert.strictEqual(applier.stats.glossaryRetries, 0);
  assert.strictEqual(applier.stats.fallbacks, 0);
});
