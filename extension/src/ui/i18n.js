/* Swaps the English written into the HTML for whatever chrome.i18n has.

   The English stays in the markup rather than being replaced by empty
   placeholders, for two reasons: the pages stay readable as source, and a key
   missing from a translation leaves the English in place instead of a blank
   label. Mark up an element with:

     data-i18n="key"             -> textContent
     data-i18n-placeholder="key" -> the placeholder attribute
     data-i18n-title="key"       -> the title attribute
     data-i18n-label="key"       -> aria-label

   Call apply() once the DOM is parsed. */
(function (HUEN) {
  'use strict';

  const ATTRIBUTE_TARGETS = {
    'data-i18n-placeholder': 'placeholder',
    'data-i18n-title': 'title',
    'data-i18n-label': 'aria-label',
  };

  function translateIn(root) {
    for (const element of root.querySelectorAll('[data-i18n]')) {
      const message = HUEN.t(element.getAttribute('data-i18n'), null);
      if (message) element.textContent = message;
    }
    for (const [dataAttr, target] of Object.entries(ATTRIBUTE_TARGETS)) {
      for (const element of root.querySelectorAll('[' + dataAttr + ']')) {
        const message = HUEN.t(element.getAttribute(dataAttr), null);
        if (message) element.setAttribute(target, message);
      }
    }
  }

  function apply() {
    translateIn(document);
    const title = HUEN.t('appName', null);
    if (title && document.title) document.documentElement.lang =
      (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || 'en';
  }

  HUEN.i18n = { apply, translateIn };
})(globalThis.HUEN);
