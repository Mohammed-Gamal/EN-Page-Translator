# Magyar → English Page Translator

A Chrome/Edge extension that translates Hungarian web pages into English
**entirely on your own machine**, using Chrome's built-in Translator model.

- **Free, with no limits.** No API key, no account, no per-character cost, no
  monthly quota.
- **Private.** Page text never leaves your computer. There is no server.
- **Works offline** once the language model has been downloaded.
- **Translates everything**, not just the main article: navigation, buttons,
  tooltips, image descriptions, form placeholders, the tab title, content
  inside shadow DOM, and anything the page loads later as you scroll.
- **Not only Hungarian.** With detection on it translates any language
  Chrome's model supports. Hungarian keeps a free fast path of its own.

---

## Requirements

| | |
|---|---|
| Browser | Desktop **Chrome 138+** or **Edge 148+** |
| Platform | Windows 10/11, macOS 13+, Linux, ChromeOS. **Not available on mobile.** |
| Disk | Chrome needs free space on the drive holding your browser profile to store the model |

The translation itself is done by Chrome's own on-device model, exposed through
the `Translator` web API. The extension supplies the page handling around it.

## Installing

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder of this repo.
4. Pin the extension so you can see its icon.

If you change a file, press the reload arrow on the extension's card at
`chrome://extensions` — there is no build step. A change to the service worker
or the manifest needs that reload; a change to a content script also needs the
page reloading.

### First run

The very first time, Chrome has to download the Hungarian–English model. Chrome
only permits that download in response to a real click, so the extension asks
for one:

- Click the toolbar icon and press **Download the model**, or
- Click **Download & translate** on the card that appears on the first
  Hungarian page you open.

After that it is automatic: every Hungarian page you visit is translated as it
loads, with no further prompts.

## Using it

| Action | How |
|---|---|
| Translate the current page | Automatic, or toolbar icon → **Translate page** |
| Translate one passage | Select it, right-click → **Translate the selected text** |
| See the Hungarian original | Hover over any translated phrase |
| Put the page back | Toolbar icon → **Show original** |
| Translate / restore quickly | `Alt+T` |
| Never translate a site | Toolbar icon → **Never translate …** |
| Only translate chosen sites | Toolbar icon → **Chosen sites** |
| Leave a term alone | **All settings** → **Glossary** |

The toolbar badge shows the state: `…` translating, `↓` downloading the model,
`EN` done, `!` needs attention.

## How it works

```
content script ──▶ detect ──▶ segmenter ──▶ queue ──▶ Translator API (on-device)
                                              │
                                              └──▶ service worker ──▶ cache
                   applier ◀───────────────────────┘
                   (writes English in, keeps the Hungarian for restore/hover)
```

Five decisions do most of the work:

**Sentences are translated whole, not fragment by fragment.** A sentence like
`A <b>kutya</b> fut a kertben` is three separate text nodes in the DOM.
Translating each one alone hands the model three meaningless scraps. The
segmenter groups every text node inside a block element into one string, marks
the boundaries, translates it as a unit, then puts the pieces back into their
original nodes — so bold text and links survive and the English still reads as a
sentence.

Whether a model carries a given token through unchanged is not something you
can reason about from outside it, so there are two marker syntaxes. If `{1}`
does not come back intact, the segment is retried with `[[1]]`; only if that
fails too does it fall back to node-by-node translation, which gives slightly
worse wording but never garbled output. The popup counts how often that
happens, which is how you find out a site needs a different format rather
than just wondering why it reads oddly.

**Visible text goes first.** An `IntersectionObserver` tracks which pending
items are near the viewport, so a long article becomes readable immediately
instead of filling in from the top down. Picking the next batch is a WeakSet
lookup and reads no layout at all — the earlier version measured every
pending element on every batch, which was quadratic in the length of the page
and forced a layout flush each time round.

**Long blocks stream.** A block over 400 characters is translated with
`translateStreaming()` and written into the page as it arrives, so a wall of
text fills in rather than sitting there.

**Everything is cached.** Translations live in IndexedDB, so site navigation
and repeated headings are translated once and reused. The second page you
visit on a site is noticeably faster than the first.

**The extension's own UI lives in a shadow root.** Host pages have aggressive
global styles and `!important` resets. Rather than fight them rule by rule, the
download prompt and the hover tooltip are rendered inside a shadow root, where
nothing inherits in and no class name can collide.

### Layout

```
extension/
  manifest.json
  _locales/      en and hu; the UI language follows the browser's
  src/
    shared/      loaded into every context
      namespace.js   the one global every classic script hangs off
      protocol.js    message names, the status enum, i18n, promise-shaped messaging
      settings.js    the settings schema and the only safe way to read one
      languages.js   language codes and the names to show for them
      lang.js        the Hungarian heuristic, "is this worth translating?"
      hash.js        cache keys
      glossary.js    terms to leave alone, and the shielding protocol
      engine.js      wrapper over the Translator API, streaming included
    content/     the page
      tags.js        which elements to skip, which are block boundaries
      segmenter.js   DOM → translation units, and the marker protocols
      applier.js     writes translations in, remembers originals, restores
      queue.js       batching, cache lookups, viewport priority, retries
      detect.js      "what language is this page, and is it worth translating?"
      overlay.js     the shadow-root prompt and tooltip
      main.js        per-frame orchestration
      content.css    the one style that touches the host page
    background/
      service-worker.js  settings, badge, menus, message router
      cache.js           the IndexedDB translation cache
      offscreen-host.js  manages the offscreen document
    offscreen/   a DOM context for pages the content script cannot serve
    ui/
      theme.css      design tokens and controls, shared by both pages
      i18n.js        swaps the English in the markup for the browser's language
      popup.*        the toolbar popup
      options.*      the settings page
```

Three contexts, one vocabulary: `shared/protocol.js` holds every message name,
the page-status enum and its labels, and the badge spec. The popup reads the
labels and the service worker reads the badges from the same table, so a status
cannot be added to one and forgotten in the other.

#### How the page language is decided

Three signals, cheapest first: the document's own `lang` attribute, then a
word-and-diacritic heuristic that only knows Hungarian but costs nothing, then
Chrome's `LanguageDetector` on a sample of the text. The detector is only
reached when the first two cannot decide, and it is what makes any-language
support possible. Whatever it concludes drives everything downstream — the
model pair, the cache keys and the wording of the prompt — not the setting.

Once a page is translated its `documentElement.lang` is set to the target, so a
screen reader stops pronouncing English with Hungarian phonetics and the browser
stops hyphenating it by Hungarian rules. Restoring puts the original value back,
including removing the attribute if there never was one.

#### The glossary

Two mechanisms, because one is not enough. A phrase that *is* a glossary term is
never sent to the model. A term inside a sentence is swapped for a `{{G0}}`
placeholder and swapped back afterwards — and if the model does not return the
placeholder intact, the sentence is translated again without it. A brand name
that got translated is a worse outcome than nothing; a sentence with `{{G0}}`
sitting in the middle of it is worse than both.

Cache entries are salted with a fingerprint of the glossary, so translations
made under one set of terms are never served under another.

#### Why there is an offscreen document

Chrome's Translator API needs a secure context. A content script runs in an
isolated world but inherits the page's origin, so on a plain `http://` page the
`Translator` global is simply absent. The extension's own pages are
`chrome-extension://`, which is secure, and an offscreen document is the only
way MV3 can keep such a page alive without a visible tab. Content scripts use
the API directly where they can and proxy through the offscreen document where
they cannot.

The catch: an offscreen document never has user activation, so it cannot trigger
the first-time model download. That has to come from the popup or an in-page
prompt. Once any context has pulled the model down, it is shared browser-wide.

## Packaging and publishing

```powershell
npm run package
```

Writes `dist/hu-en-page-translator-<version>.zip` with `manifest.json` at the
archive root, which is what the Chrome Web Store requires — zipping the
`extension` folder itself puts `extension/manifest.json` inside the archive and
is rejected. The script refuses to build if the 128×128 icon is missing, if the
version is not one to four dot-separated numbers, if `default_locale` points at
a `messages.json` that is not in the package, or if the manifest references an
icon that is not there.

`docs/store-listing.md` has the rest: the single-purpose statement, a
justification for every permission, the data-usage answers, and the listing
copy. `docs/privacy-policy.md` is the policy itself — the store requires a
publicly reachable URL for one, because an extension that handles user data
needs a policy even when it only ever stores that data locally.

Two things the store will not let you skip: at least one screenshot at
1280×800 or 640×400, and that privacy policy URL.

## Development

Run the tests. No dependencies, no build step, no browser needed:

```powershell
node --test "tests/*.test.js"
```

- `tests/unit.test.js` — the marker protocol, the Hungarian heuristic, cache
  keys, settings normalisation, the shared status vocabulary, and chunking.
- `tests/dom.test.js` — the DOM walker and the applier: that inline markup does
  not split a sentence, that scripts / `translate="no"` / textareas are skipped
  even when a single node is handed over on its own, that attributes and shadow
  DOM are picked up, and that restoring a page puts it back exactly and leaves
  it translatable again. It ships a tiny DOM shim rather than pulling in jsdom,
  so it stays dependency-free.
- `tests/manifest.test.js` — structural checks: every shipped script parses,
  every path in the manifest and in each HTML page exists, no JavaScript file is
  orphaned, the content-script list is in dependency order, no permission is
  requested that the code never uses, every `getElementById` has a matching
  element, and the locales agree with each other and with the code — every key
  the code asks for is defined, every key defined is used, and the placeholders
  line up.

#### The browser harnesses

Two things cannot be tested against the DOM shim: the queue, which needs a real
`IntersectionObserver` and real layout, and the cache, which needs IndexedDB.
Both have a self-contained page under `tests/browser/` that drives the real
module against a fake model and prints PASS/FAIL. They need to be served over
http rather than opened from disk, because Chrome blocks IndexedDB on
`file://`:

```powershell
npm run serve
```

Then open `http://127.0.0.1:8733/tests/browser/queue.html` and
`http://127.0.0.1:8733/tests/browser/cache.html`. The tab title is PASS or FAIL,
so you do not have to read the list unless something broke.

`tests/browser/queue.html` covers the marker retry, the node-by-node fallback,
glossary shielding and its retry, the streaming path, cache hits and the fatal
error path. `tests/browser/cache.html` covers the IndexedDB store end to end,
the migration from the old `chrome.storage.local` layout included.

There is no bundler. Content scripts are plain classic scripts sharing a
`globalThis.HUEN` namespace, so you can edit a file and just press reload on
`chrome://extensions`.

**Load order matters.** `protocol.js` defines `HUEN.ERR`, which `engine.js`
destructures at load time; several content modules do the same. The order is
fixed in `manifest.json` and asserted in `tests/manifest.test.js`.

### Manual test page

`tests/fixture.html` is a Hungarian page built to exercise the hard cases:
inline markup inside sentences, attributes, tables, dynamically injected
content, shadow DOM, and content that must *not* be touched (code blocks,
`translate="no"`, textareas, prices and dates). Open it from disk and check each
section against its stated expectation.

The manifest matches `file:///*`, but Chrome still requires you to turn on
**Allow access to file URLs** on the extension's details page.

## Note on the repo layout

`pyproject.toml` and `.python-version` come from `uv init`, which was used to
create the git repository. Nothing in the extension uses them — a browser
extension is HTML/CSS/JS — and the `[project.scripts]` entry points at a Python
package that does not exist, so `uv run` and `uv build` will fail. Both files can
be deleted without affecting anything.

## Known limitations

- **Desktop only.** Chrome's built-in AI APIs do not exist on mobile.
- **Quality is NMT, not an LLM.** Chrome's model is a solid machine-translation
  model, roughly Google Translate quality. It is very good on ordinary prose and
  weaker on idiom, legal/bureaucratic register and puns. Hover any sentence to
  see the Hungarian original when something reads oddly.
- **Translations are processed sequentially** by the browser. A very long page
  takes a few seconds to finish, which is why viewport-first ordering matters.
- **Cross-origin iframes** need `allow="translator"` from the hosting page, so
  embedded third-party widgets may stay Hungarian.
- **Canvas, images and video** contain no text nodes and cannot be translated.
- **Cache eviction is near-LRU, not exact.** A hit only refreshes its
  timestamp when the one on record is already a day old, because writing on
  every hit would spend a write on the hot path the cache exists to keep cheap.
  Within a day, ties are broken arbitrarily.
- **The cache size is an estimate.** Entry counts are exact; the kilobyte
  figure is extrapolated from a sample of a few hundred records, because adding
  up every one is the full scan this store exists to avoid.
- **Streaming is direct-path only.** On a plain `http://` page the work is
  proxied through the offscreen document, and pushing partial results back
  through runtime messaging would cost a round trip per chunk.
- **A glossary term is shielded, not guaranteed.** If the model drops the
  placeholder the sentence is retranslated unprotected, so the term may still
  come back translated — just never as a visible marker.
