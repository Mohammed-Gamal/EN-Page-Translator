/* Structural checks on the extension itself.

   None of the other test files ever loads the service worker, the popup or the
   content-script orchestrator, so a syntax error in any of them used to surface
   only as a blank popup or a dead extension after a reload. These tests parse
   every script the extension ships and verify that everything the manifest
   points at is actually there. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');

function read(relative) {
  return fs.readFileSync(path.join(EXT, relative), 'utf8');
}

const manifest = JSON.parse(read('manifest.json'));

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(EXT, full).split(path.sep).join('/'));
  }
  return out;
}

const files = walk(EXT, []);
const scripts = files.filter((f) => f.endsWith('.js'));

/* ---------- every script parses ---------- */

for (const file of scripts) {
  test(`${file} parses`, () => {
    // new vm.Script compiles without running, which is exactly the check we
    // want: no chrome.* API, no DOM, just "is this valid JavaScript".
    assert.doesNotThrow(function () {
      new vm.Script(read(file), { filename: file });
    });
  });
}

/* ---------- the manifest points at real files ---------- */

test('every path in the manifest exists', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
  ];
  for (const script of manifest.content_scripts) {
    referenced.push(...script.js, ...script.css);
  }
  for (const target of referenced) {
    assert.ok(fs.existsSync(path.join(EXT, target)), `missing: ${target}`);
  }
});

test('the locale files are valid JSON', () => {
  for (const locale of LOCALES) {
    assert.doesNotThrow(function () { messages(locale); }, `_locales/${locale}`);
  }
});

test('every HTML page loads scripts that exist', () => {
  for (const page of files.filter((f) => f.endsWith('.html'))) {
    const dir = path.dirname(page);
    const html = read(page);
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|#)/.test(ref)) continue;
      const resolved = path.normalize(path.join(EXT, dir, ref));
      assert.ok(fs.existsSync(resolved), `${page} refers to a missing ${ref}`);
    }
  }
});

test('no JavaScript file is orphaned', () => {
  // Anything not loaded by the manifest or by one of the HTML pages is dead
  // weight, and the import lists are the only record of what actually runs.
  const loaded = new Set([
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((s) => s.js),
  ]);

  // importScripts() inside the service worker, and <script src> in the pages.
  for (const file of scripts.concat(files.filter((f) => f.endsWith('.html')))) {
    const source = read(file);
    const dir = path.dirname(file);
    for (const match of source.matchAll(/(?:importScripts\(|src=")([^")]+)/g)) {
      for (const raw of match[1].split(/['",\s]+/)) {
        if (!raw.endsWith('.js')) continue;
        const absolute = raw.startsWith('/')
          ? raw.slice(1)
          : path.join(dir, raw).split(path.sep).join('/');
        loaded.add(path.normalize(absolute).split(path.sep).join('/'));
      }
    }
  }

  for (const file of scripts) {
    assert.ok(loaded.has(file), `${file} is never loaded by anything`);
  }
});

/* ---------- the content-script list is in dependency order ---------- */

test('shared modules load before the code that destructures them', () => {
  const list = manifest.content_scripts[0].js;
  const position = function (name) { return list.findIndex((f) => f.endsWith(name)); };

  assert.ok(position('namespace.js') === 0, 'the namespace must come first');
  // protocol.js defines HUEN.ERR, which engine.js reads at load time; queue.js
  // and main.js destructure several of these at load time too.
  assert.ok(position('protocol.js') < position('engine.js'));
  assert.ok(position('protocol.js') < position('queue.js'));
  assert.ok(position('tags.js') < position('segmenter.js'));
  assert.ok(position('tags.js') < position('detect.js'));
  assert.ok(position('lang.js') < position('segmenter.js'));
  assert.ok(position('hash.js') < position('queue.js'));
  // detect.js and main.js read language names; queue.js builds a glossary.
  assert.ok(position('languages.js') < position('detect.js'));
  assert.ok(position('languages.js') < position('main.js'));
  assert.ok(position('glossary.js') < position('queue.js'));
  // glossary.create() fingerprints its terms with hash.fnv1a.
  assert.ok(position('hash.js') < position('glossary.js'));
  assert.ok(position('segmenter.js') < position('queue.js'));
  assert.ok(position('applier.js') < position('queue.js'));
  assert.ok(position('overlay.js') < position('main.js'));
  assert.ok(position('main.js') === list.length - 1, 'main.js must come last');
});

/* ---------- translations ---------- */

const LOCALES = fs.existsSync(path.join(EXT, '_locales'))
  ? fs.readdirSync(path.join(EXT, '_locales'))
  : [];

function messages(locale) {
  return JSON.parse(read(path.join('_locales', locale, 'messages.json')));
}

test('the manifest declares a default locale that exists', () => {
  assert.ok(manifest.default_locale, 'default_locale is required once _locales exists');
  assert.ok(LOCALES.includes(manifest.default_locale),
    `no _locales/${manifest.default_locale}`);
});

test('every __MSG_ name in the manifest is a real key', () => {
  const base = messages(manifest.default_locale);
  const raw = read('manifest.json');
  for (const match of raw.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    assert.ok(base[match[1]], `manifest uses __MSG_${match[1]}__, which is not defined`);
  }
});

test('every locale defines the same keys', () => {
  // A key missing from a translation shows the key name to the user, not the
  // English, so a mismatch is a visible bug rather than a graceful fallback.
  const base = messages(manifest.default_locale);
  const expected = Object.keys(base).sort();
  for (const locale of LOCALES) {
    assert.deepStrictEqual(Object.keys(messages(locale)).sort(), expected,
      `_locales/${locale} does not match _locales/${manifest.default_locale}`);
  }
});

test('placeholders line up across locales', () => {
  const base = messages(manifest.default_locale);
  for (const locale of LOCALES) {
    const other = messages(locale);
    for (const key of Object.keys(base)) {
      const wanted = (base[key].message.match(/\$\d/g) || []).sort();
      const got = (other[key].message.match(/\$\d/g) || []).sort();
      assert.deepStrictEqual(got, wanted,
        `${locale}/${key} has ${got.length} placeholders, expected ${wanted.length}`);
    }
  }
});

test('the store-facing strings fit the Chrome Web Store limits', () => {
  // Over these, the upload is rejected outright rather than warned about, and
  // the limits apply to every locale, not just the default one.
  const LIMITS = { appName: 75, appShortName: 12, appDescription: 132 };
  for (const locale of LOCALES) {
    const table = messages(locale);
    for (const [key, limit] of Object.entries(LIMITS)) {
      const text = table[key].message;
      assert.ok(text, `${locale}/${key} is empty, which the store rejects`);
      assert.ok(text.length <= limit,
        `${locale}/${key} is ${text.length} characters, over the ${limit} limit`);
    }
  }
});

test('every message key the code asks for is defined', () => {
  // t('key', 'English fallback') and data-i18n="key" are the only two ways a
  // key is ever requested, so both are swept here.
  const base = messages(manifest.default_locale);
  const sources = scripts.concat(files.filter((f) => f.endsWith('.html')));
  const asked = new Set();

  for (const file of sources) {
    const source = read(file);
    for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) {
      asked.add(match[1]);
    }
    // Only in markup: i18n.js documents the attribute in a comment, and the
    // example key there is not a real message.
    if (!file.endsWith('.html')) continue;
    for (const match of source.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z0-9_]+)"/g)) {
      asked.add(match[1]);
    }
  }

  assert.ok(asked.size > 20, 'the sweep found suspiciously few keys');
  for (const key of asked) {
    assert.ok(base[key], `the code asks for "${key}", which no locale defines`);
  }
});

test('no message is defined that nothing uses', () => {
  const base = messages(manifest.default_locale);
  const haystack = scripts.concat(files.filter((f) => f.endsWith('.html')))
    .map(read).join('\n') + read('manifest.json');
  for (const key of Object.keys(base)) {
    assert.ok(haystack.includes(key), `"${key}" is translated but never used`);
  }
});

/* ---------- permissions ---------- */

test('the manifest asks for no permission the code never uses', () => {
  const source = scripts.map(read).join('\n');
  const used = {
    storage: /chrome\.storage\./,
    offscreen: /chrome\.offscreen\./,
    contextMenus: /chrome\.contextMenus\./,
    // These two have no namespace of their own: unlimitedStorage lifts the
    // quota on the IndexedDB translation cache, and activeTab is what lets the
    // popup read the URL of the tab it was opened from.
    unlimitedStorage: /indexedDB\.open/,
    activeTab: /chrome\.tabs\.query/,
  };
  for (const permission of manifest.permissions) {
    const pattern = used[permission];
    assert.ok(pattern, `no rule covers the "${permission}" permission`);
    assert.match(source, pattern, `"${permission}" is requested but unused`);
  }
});

/* ---------- the UI scripts and their pages agree ---------- */

test('every getElementById in the UI has a matching element', () => {
  // The popup and the options page are wired by id, and a renamed id fails
  // silently at runtime as a null dereference in a context nobody is watching.
  const pages = { 'src/ui/popup.js': 'src/ui/popup.html',
    'src/ui/options.js': 'src/ui/options.html' };

  for (const [script, page] of Object.entries(pages)) {
    const html = read(page);
    const present = new Set(
      [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = new Set(
      [...read(script).matchAll(/getElementById\('([^']+)'\)|\$\('([^']+)'\)/g)]
        .map((m) => m[1] || m[2]));

    for (const id of wanted) {
      assert.ok(present.has(id), `${script} looks for #${id}, missing from ${page}`);
    }
  }
});
