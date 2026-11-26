# Privacy policy — Magyar → English Page Translator

_Last updated: 26 November 2026_

## The short version

This extension does not send your data anywhere. It has no server, makes no
network requests of any kind, and contains no analytics, tracking or
advertising code.

## What the extension does with your data

To translate a page, the extension has to read the text on it. That text is
passed to the translation model **built into your own browser**, which runs
locally on your machine. Neither the page text nor the translation is
transmitted to the developer or to any third party, because the extension
makes no network requests at all.

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

## How to remove your data

- **Clear the translation cache:** extension options → Memory → **Clear now**.
- **Stop caching entirely:** extension options → Memory → turn off
  *Remember translations between page loads*.
- **Remove everything:** uninstall the extension. Chrome deletes its settings
  and its cache along with it.

## Permissions

| Permission | What it is for |
|---|---|
| Access to the sites you visit | Reading the text on a page and writing the translation back in. A translator cannot know in advance which sites you will want translated. |
| `storage`, `unlimitedStorage` | Keeping your settings and the local translation cache |
| `offscreen` | Chrome's translation model needs a secure context, which a content script on an `http://` page does not have. The extension runs the translation in its own hidden page instead. |
| `activeTab` | Letting the popup show which site you are on, for the "always / never translate this site" switches |
| `contextMenus` | Adding the right-click entries for translating a page or a selection |

## Third parties

There are none. The extension bundles no third-party code, loads no remote
code, and talks to no external service. The translation model is part of your
browser and is governed by your browser's own privacy policy.

## Changes

If this policy ever changes, the updated version will be published at the same
address and the date at the top will change.

## Contact

Questions or concerns: open an issue on the project's repository.
