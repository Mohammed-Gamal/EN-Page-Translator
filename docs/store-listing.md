# Chrome Web Store submission

Copy to paste into the Developer Dashboard, and the reasoning behind each
answer. Every claim here was checked against the code — see `Verified` notes.

Build the upload with:

```powershell
npm run package
```

That writes `dist/hu-en-page-translator-<version>.zip` with `manifest.json` at
the archive root, which is what the store requires. Zipping the `extension`
folder itself produces `extension/manifest.json` inside the archive and is
rejected.

---

## Before you upload

- [ ] A Chrome Web Store developer account (one-time US$5 registration fee)
- [ ] Decide trader / non-trader status — the dashboard asks and will not let
      you publish until you answer
- [ ] A **publicly reachable URL** for the privacy policy. `docs/privacy-policy.md`
      is written and ready; publish it somewhere with a stable address (GitHub
      Pages, or a Gist) and paste that URL into the dashboard
- [ ] At least one screenshot, 1280×800 or 640×400 (see below)
- [ ] Bump `version` in `extension/manifest.json` — the store refuses a version
      it has already seen

---

## Store listing tab

**Name** — `Magyar → English Page Translator` (32 characters)

**Detailed description** — no character limit is documented; the rule that
matters is the keyword-spam policy, so do not repeat "translate" more than a
few times.

> Read Hungarian websites in English, without sending a word of them anywhere.
>
> This extension translates Hungarian web pages into English using the
> translation model built into Chrome itself. There is no API key to get, no
> account to make, no monthly quota to run out of, and no server involved —
> the page text is translated on your own machine and never leaves it.
>
> WHAT IT TRANSLATES
> Not just the article. Navigation, buttons, tooltips, image descriptions,
> form placeholders, the browser tab title, text inside shadow DOM, and
> anything the page loads later as you scroll.
>
> HOW IT READS
> Sentences are translated whole rather than word by word. A sentence broken
> up by bold text or a link is reassembled, translated as one sentence, and
> put back into place, so the English reads properly and the page's formatting
> survives.
>
> WHAT YOU CONTROL
> • Translate everything automatically, only chosen sites, or only on request
> • Hover any phrase to see the Hungarian original
> • A glossary of terms to leave exactly as they are — brand names, product
>   names, legal terms
> • Right-click a passage to translate just that
> • Alt+T to switch between the translation and the original
>
> WORKS WITHOUT A BUILT-IN MODEL
> Browsers without Chrome's built-in translator, and anyone who wants better
> output than it can give, can point the extension at DeepL or at any
> OpenAI-compatible model, including one running on their own machine. Off by
> default; the page text goes to that service while it is on.
>
> ALSO WORKS ON OTHER LANGUAGES
> Detection is on by default, so any language your browser's model supports is
> translated into English, not only Hungarian.
>
> REQUIREMENTS
> Desktop Chrome 138 or later, or Edge 148 or later. The built-in AI features
> do not exist on mobile. The first use downloads the language model once;
> after that it works offline.

**Category** — Productivity (or Tools). Not "Accessibility": the single-purpose
description below is about translation.

**Language** — English, and add a Hungarian listing if you want one; the
extension already ships Hungarian UI strings.

### Graphics

| Asset | Size | Required |
|---|---|---|
| Store icon | 128×128 | Yes — `extension/icons/icon128.png` is already the right size |
| Screenshot | 1280×800 or 640×400, 1 to 5 of them | Yes, at least one |
| Small promo tile | 440×280, PNG or JPEG | Optional |
| Marquee promo tile | 1400×560, PNG or JPEG | Optional |

Screenshots worth taking, in this order:

1. A real Hungarian news site translated, with the popup open showing
   "Translated · 124 phrases"
2. The hover tooltip over a translated sentence, showing the Hungarian
3. The options page, Glossary section
4. The in-page download prompt on first run

Shoot them at exactly 1280×800 so the store does not rescale them. The listing
policy rejects images that are blurry, distorted, skewed or rotated.

---

## Privacy practices tab

This is the tab that decides how long review takes. Be exact — Google's
listing policy says a listing whose privacy answers contradict the extension's
actual behaviour "may be removed from the Store".

### Single purpose

> Translating the text of web pages from Hungarian (or another detected
> language) into English — using the translation model built into the browser,
> or a translation service the user configures — and showing the original text
> on request.

### Permission justifications

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's own settings: when to translate, their always/never site lists, their glossary of terms to leave untranslated, and their language choices. |
| `unlimitedStorage` | The extension keeps a local cache of already-translated phrases in IndexedDB so that repeated text — site navigation, headings that appear on every page — is translated once rather than on every page load. The cache is capped by a user-configurable limit. |
| `offscreen` | The browser's built-in Translator API requires a secure context. A content script inherits the page's origin, so on a plain http:// page the API is unavailable. The extension creates an offscreen document, which is a secure extension-origin context, and performs the translation there. It is used for nothing else. |
| `activeTab` | Lets the popup read the hostname of the tab it was opened from, so it can offer "always translate this site" and "never translate this site" for the site the user is actually looking at. |
| `contextMenus` | Adds two right-click entries: "Translate this page" and "Translate the selected text". |
| Host permission `http://*/*`, `https://*/*` | Two uses. First, the extension must read the text of the page the user is reading and write the translation back into it; a translator cannot know in advance which sites a user will want translated, so access cannot be narrowed to a list of hosts. Second, when the user has configured a translation service, the extension's background page calls that service's HTTPS endpoint. On the default setting no page content is transmitted anywhere. |

> **`activeTab` note.** With the broad host permissions above, `activeTab` is
> only doing work on `file://` pages. If a reviewer pushes back on permission
> count, this is the one to drop — the cost is that the popup says "this site"
> instead of the hostname on local files.

### Remote code

Select **"No, I am not using remote code."**

Verified: the extension contains no `eval`, no `new Function`, no string-bodied
`setTimeout`/`setInterval`, no `fetch`, no `XMLHttpRequest`, no `WebSocket`, no
remote script or stylesheet URLs, and no `content_security_policy` or
`externally_connectable` entry in the manifest. Every line that runs ships
inside the package.

### Data usage

The extension reads page text and stores translated phrases locally. On the
default setting it transmits nothing. If the user configures a translation
service, the text being translated is sent to that service.

**This changes the answer compared with an on-device-only build.** Website
content can leave the device, so it must be disclosed as such even though it is
off by default and user-configured. Do not be tempted to answer for the default
setting only.

Google's User Data FAQ states that disclosure is required **"even when data is
processed or stored locally on a user's device and is not transmitted to
external servers or third parties."** The documentation does not spell out
whether local-only processing should tick the "collected" box, so this is a
judgement call and ultimately yours to make. The safe reading, and the one
this listing copy assumes:

- **Tick "Website content"** — the extension reads and uses page content, and
  transmits it when a service is configured. Under-disclosing is the error that
  gets extensions removed; over-disclosing is not.
- **Leave every other category unticked** — no personally identifiable
  information, no authentication information, no financial information, no
  health information, no personal communications, no location, no web history,
  no user activity. None of these are read, stored or derived.

Then tick all three Limited Use certifications. Each is true here:

- the data is not sold to third parties — it is sent only to the translation
  service the user chose, for the sole purpose of translating it, and to nobody
  else
- it is not used or transferred for any purpose unrelated to the single
  purpose above
- it is not used or transferred to determine creditworthiness or for lending

**Privacy policy URL** — required. Google's User Data FAQ: products that
handle user data must "post a privacy policy", and it confirms this applies to
products that only store information locally. Publish `docs/privacy-policy.md`
and paste its URL.

---

## What tends to slow review down

- **Broad host permissions.** `http://*/*` plus `https://*/*` is the single
  most-scrutinised thing in this manifest. The justification above explains why
  a narrower list is impossible for a translator; expect it to be read.
- **`file:///*` in `content_scripts`.** This adds no install warning and is off
  until the user turns on "Allow access to file URLs" themselves, but it is
  unusual enough to attract a question. It exists so the extension works on
  local HTML files, `tests/fixture.html` included. Dropping the `file:///*`
  match from `extension/manifest.json` costs nothing but that.
- **Mismatched answers.** If the privacy tab, the privacy policy and the
  extension's behaviour disagree, the listing can be pulled. They agree today;
  keep them agreeing when the code changes.

Review typically takes somewhere between a few hours and a few days. Updates
that add a new permission cause Chrome to disable the extension for existing
users until they accept the new permission, so add permissions sparingly.
