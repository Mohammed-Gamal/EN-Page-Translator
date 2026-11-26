# Privacy policy — Magyar → English Page Translator

_Last updated: 26 November 2026_

## The short version

Out of the box, this extension sends your data nowhere: it translates with the
model built into your browser, on your machine.

It can also be pointed at a translation service, which you set up yourself.
**While a service is in use, the text of the pages you translate is sent to
it.** That is off by default, it takes an API key you supply, and the extension
tells you on screen whenever it is on.

Either way there is no server of ours, no analytics, no tracking and no
advertising code.

## What the extension does with your data

To translate a page, the extension has to read the text on it. What happens
next depends on which translator you have chosen in the settings.

### On the built-in model (the default)

The text is passed to the translation model built into your own browser, which
runs locally. Nothing is transmitted anywhere, by us or by anyone else: on this
setting the extension makes no network requests at all.

### On a translation service (off by default)

If you choose a service and supply an API key, the text to be translated is
sent to **that service, and only that service**, over HTTPS, from the
extension's background page. Which one it is, is your choice:

| Choice | Where the text goes |
|---|---|
| DeepL | DeepL's API servers |
| An OpenAI-compatible endpoint | Whatever address you entered — a hosted provider, or a model running on your own machine, in which case nothing leaves it |

What is sent is the text being translated and the language pair. No URL, no
page address, no account identifier and nothing about you is attached. The
service's own privacy policy then governs what it does with the text, which is
why the extension names the destination in the settings rather than hiding it.

Your API key is held in this browser profile and used only by the extension's
background page. It is never given to a content script, never exposed to a web
page, and never sent anywhere except the service you chose. It is stored
unencrypted, as browser extension storage has nowhere to keep a secret that
the browser itself could not read; treat it as you would any key saved on your
own machine.

Nothing is ever sent to the developer. There is no server of ours to send it
to.

### What is stored, and where

Everything is stored locally in your own browser profile. None of it is
readable by the developer.

| What | Where | Why |
|---|---|---|
| Your settings — when to translate, your site lists, your glossary, your language choices | `chrome.storage.local` | So the extension behaves the way you configured it |
| Translated phrases, paired with the original phrase | IndexedDB, in the extension's own storage | So a phrase that appears on every page of a site is translated once instead of every time |

The translation cache can contain fragments of text from pages you have
visited. It is capped (20,000 phrases by default) and the least recently used
entries are discarded when the cap is passed.

### What is never collected

- No personally identifiable information
- No authentication details, passwords or cookies
- No financial or payment information
- No health information
- No browsing history or list of sites visited
- No analytics, telemetry, crash reports or usage statistics
- No advertising identifiers
- No page addresses, even when a translation service is in use

## How to remove your data

- **Clear the translation cache:** extension options → Memory → **Clear now**.
- **Stop caching entirely:** extension options → Memory → turn off
  *Remember translations between page loads*.
- **Stop using a service:** extension options → Translator → set *Translate
  with* to *Only the browser's own model*, and clear the API key field.
- **Remove everything:** uninstall the extension. Chrome deletes its settings,
  your API key and the cache along with it.

## Permissions

| Permission | What it is for |
|---|---|
| Access to the sites you visit | Reading the text on a page and writing the translation back in. A translator cannot know in advance which sites you will want translated. The same permission lets the background page reach a translation service, if you have set one up. |
| `storage`, `unlimitedStorage` | Keeping your settings and the local translation cache |
| `offscreen` | Chrome's translation model needs a secure context, which a content script on an `http://` page does not have. The extension runs the translation in its own hidden page instead. |
| `activeTab` | Letting the popup show which site you are on, for the "always / never translate this site" switches |
| `contextMenus` | Adding the right-click entries for translating a page or a selection |

## Third parties

On the default setting there are none. The extension bundles no third-party
code and loads no remote code; the translation model is part of your browser
and is governed by your browser's own privacy policy.

If you configure a translation service, that service is a third party and its
own privacy policy applies to the text sent to it. The extension talks to no
other external service in either case.

## Changes

If this policy ever changes, the updated version will be published at the same
address and the date at the top will change.

## Contact

Questions or concerns: open an issue on the project's repository.
