/* Translation through a cloud provider, for browsers with no built-in model
   and for people who want better output than an NMT model can give.

   This file is loaded only into the service worker, on purpose. It is the one
   context with host permissions, no page origin, and no untrusted script
   running beside it: the API key never enters a page, and a hostile page
   cannot read it or make requests with it.

   Two shapes of provider, because the useful ones divide that way:

     deepl   - a translation API that takes an array of strings and returns an
               array of translations. Fast, cheap, has a free tier, and is
               noticeably better than general MT on Hungarian. Still machine
               translation.
     openai  - any endpoint speaking the OpenAI chat-completions protocol,
               which is most of them: OpenAI, Groq, Together, OpenRouter, and
               a local Ollama or LM Studio server. An instruction-following
               model is what makes "reads like a native speaker" achievable,
               because it can be told about register and idiom. */
(function (HUEN) {
  'use strict';

  const { ERR } = HUEN;

  const REQUEST_TIMEOUT_MS = 45000;
  /* DeepL accepts up to 50 texts per request; the queue sends ten at a time,
     so this is only a guard against a future change. */
  const DEEPL_MAX_TEXTS = 50;
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;

  const DEFAULTS = {
    deepl: { free: 'https://api-free.deepl.com/v2', pro: 'https://api.deepl.com/v2' },
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  };

  function tagged(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* A fetch that gives up rather than hanging a page's translation forever,
     and that retries the statuses worth retrying. */
  async function request(url, options, attempt) {
    const tries = attempt || 1;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } catch (err) {
      clearTimeout(timer);
      if (tries < MAX_ATTEMPTS) {
        await sleep(400 * tries);
        return request(url, options, tries + 1);
      }
      const aborted = err && err.name === 'AbortError';
      throw tagged(ERR.CLOUD_FAILED, aborted
        ? 'The translation service did not answer in time.'
        : 'Could not reach the translation service.');
    }
    clearTimeout(timer);

    if (RETRY_STATUSES.has(response.status) && tries < MAX_ATTEMPTS) {
      /* Honour Retry-After when the service sends one; it knows better than a
         fixed backoff does. */
      const after = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0
        ? Math.min(after * 1000, 10000)
        : 500 * tries * tries);
      return request(url, options, tries + 1);
    }
    return response;
  }

  /* The body of a failed response, for the message shown to the user. Capped,
     and with the credential scrubbed: services do echo the key back in error
     bodies, and from here the text goes into an error message that is shown on
     the options page and may be written to a log. */
  async function failureText(response, secret) {
    let body = '';
    try {
      body = (await response.text()).slice(0, 300);
    } catch (_) { /* nothing readable */ }
    if (secret && body.includes(secret)) body = body.split(secret).join('[key]');
    return body ? response.status + ': ' + body : 'HTTP ' + response.status;
  }

  function classify(status) {
    if (status === 401 || status === 403) {
      return tagged(ERR.CLOUD_AUTH,
        'The translation service rejected the API key. Check it in the extension settings.');
    }
    // DeepL answers 456 when the character quota is spent.
    if (status === 456 || status === 402) {
      return tagged(ERR.CLOUD_QUOTA,
        'The translation account is out of quota.');
    }
    if (status === 429) {
      return tagged(ERR.CLOUD_FAILED, 'The translation service is rate limiting us.');
    }
    return null;
  }

  /* ---------- DeepL ---------- */

  /* DeepL runs the two plans on two hosts and rejects a key sent to the wrong
     one with 403 — which is the same status as a genuinely bad key, and the
     body does not say the host was the problem. The documented rule is that a
     Free key ends in ":fx" and belongs to api-free.deepl.com, while anything
     else belongs to api.deepl.com.

     That rule is DeepL's convention rather than a promise, and getting it
     wrong tells somebody their brand-new key is invalid when it is not. So the
     suffix picks which host to try first, and the other one is tried before
     anybody is told their key was rejected. An endpoint the reader typed in
     themselves is an instruction, not a guess, and is never second-guessed. */
  function deeplBase(settings) {
    return deeplHosts(settings)[0];
  }

  function deeplHosts(settings) {
    if (settings.cloudBaseUrl) return [settings.cloudBaseUrl.replace(/\/+$/, '')];
    const key = settings.cloudApiKey || '';
    return key.endsWith(':fx')
      ? [DEFAULTS.deepl.free, DEFAULTS.deepl.pro]
      : [DEFAULTS.deepl.pro, DEFAULTS.deepl.free];
  }

  function isWrongHost(status) {
    return status === 401 || status === 403;
  }

  async function deeplTranslations(response, texts) {
    const data = await response.json();
    const out = (data && data.translations) || [];
    if (out.length !== texts.length) {
      throw tagged(ERR.CLOUD_FAILED,
        'DeepL returned ' + out.length + ' translations for ' + texts.length + ' strings.');
    }
    return out.map(function (entry) { return String(entry.text || ''); });
  }

  async function translateWithDeepl(settings, texts, source, target) {
    if (!settings.cloudApiKey) {
      throw tagged(ERR.CLOUD_AUTH, 'No DeepL API key is set in the extension settings.');
    }
    if (texts.length > DEEPL_MAX_TEXTS) {
      const head = await translateWithDeepl(settings, texts.slice(0, DEEPL_MAX_TEXTS), source, target);
      const tail = await translateWithDeepl(settings, texts.slice(DEEPL_MAX_TEXTS), source, target);
      return head.concat(tail);
    }

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'DeepL-Auth-Key ' + settings.cloudApiKey,
      },
      body: JSON.stringify({
        text: texts,
        source_lang: source.toUpperCase(),
        target_lang: target.toUpperCase(),
        // Keeps our {1} and {{G0}} markers out of DeepL's tag handling.
        tag_handling: null,
        preserve_formatting: true,
      }),
    };

    const hosts = deeplHosts(settings);
    let rejected = null;
    for (let i = 0; i < hosts.length; i++) {
      const response = await request(hosts[i] + '/translate', options);
      if (response.ok) return deeplTranslations(response, texts);

      if (isWrongHost(response.status) && i + 1 < hosts.length) {
        // Might be the other plan's host rather than a bad key. Try it.
        rejected = response.status;
        continue;
      }
      throw classify(response.status) ||
        tagged(ERR.CLOUD_FAILED, 'DeepL refused the request (' +
          await failureText(response, settings.cloudApiKey) + ').');
    }

    throw classify(rejected) ||
      tagged(ERR.CLOUD_AUTH, 'DeepL rejected the API key.');
  }

  /* ---------- OpenAI-compatible chat completions ---------- */

  /* Everything that makes the output read like a person wrote it lives here.
     The placeholder rule is not optional: the queue reassembles sentences from
     these markers, and a model that renames or drops one costs the page its
     markup. */
  function systemPrompt(sourceName, targetName) {
    return [
      'You are a professional ' + sourceName + '-to-' + targetName + ' translator.',
      '',
      'Translate each input string into ' + targetName + '. Rules:',
      '',
      '1. Write what a native ' + targetName + ' speaker would write. Use natural',
      '   word order and idiom. Do not translate word by word, and do not keep',
      '   ' + sourceName + ' sentence structure where ' + targetName + ' would not use it.',
      '2. Keep the register of the original: formal stays formal, marketing copy',
      '   stays marketing copy, a button label stays a button label.',
      '3. Placeholders such as {1}, [[2]] and {{G0}} mark positions in the page',
      '   markup. Reproduce every one exactly, once, in the order given. Never',
      '   rename, translate, drop, merge or add one. Text may move around them.',
      '4. Keep leading and trailing spaces, and the original punctuation style.',
      '5. Return a proper noun, product code, or string already in ' + targetName + ',',
      '   unchanged.',
      '6. Add nothing: no notes, no explanations, no quotation marks that were',
      '   not there, no markdown.',
      '',
      'Reply with a JSON array of strings: one translation per input, in the',
      'same order, and nothing else.',
    ].join('\n');
  }

  /* Models wrap JSON in prose or fences often enough that this has to cope. */
  function parseArray(content, expected) {
    if (typeof content !== 'string') return null;
    let text = content.trim();

    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    if (fence) text = fence[1].trim();

    if (text[0] !== '[') {
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end <= start) return null;
      text = text.slice(start, end + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== expected) return null;
    return parsed.map(function (entry) { return entry == null ? '' : String(entry); });
  }

  async function callChat(settings, messages) {
    const base = (settings.cloudBaseUrl || DEFAULTS.openai.base).replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    /* A local Ollama or LM Studio server needs no key, so an empty one is not
       an error here the way it is for a hosted provider. */
    if (settings.cloudApiKey) headers.Authorization = 'Bearer ' + settings.cloudApiKey;

    const response = await request(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.cloudModel || DEFAULTS.openai.model,
        messages,
        // Translation wants the same answer every time; it also makes the
        // cache worth more.
        temperature: 0,
      }),
    });

    if (!response.ok) {
      throw classify(response.status) ||
        tagged(ERR.CLOUD_FAILED, 'The model endpoint refused the request (' +
          await failureText(response, settings.cloudApiKey) + ').');
    }

    const data = await response.json();
    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (typeof content !== 'string') {
      throw tagged(ERR.CLOUD_FAILED, 'The model returned no text.');
    }
    return content;
  }

  async function translateWithOpenAi(settings, texts, source, target) {
    const names = HUEN.languages
      ? [HUEN.languages.nameOf(source), HUEN.languages.nameOf(target)]
      : [source, target];
    const system = systemPrompt(names[0], names[1]);

    const content = await callChat(settings, [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(texts) },
    ]);

    const parsed = parseArray(content, texts.length);
    if (parsed) return parsed;

    /* The model did not return a usable array. Rather than lose the batch,
       ask again one string at a time: slower and dearer, but it only happens
       when the model has already misbehaved once. */
    const out = [];
    for (const text of texts) {
      const single = await callChat(settings, [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify([text]) },
      ]);
      const one = parseArray(single, 1);
      out.push(one ? one[0] : text);
    }
    return out;
  }

  /* ---------- what the rest of the extension calls ---------- */

  const PROVIDERS = {
    deepl: translateWithDeepl,
    openai: translateWithOpenAi,
  };

  function isConfigured(settings) {
    if (settings.cloudProvider === 'openai') {
      // A local server needs no key, so a base URL is enough on its own.
      return !!(settings.cloudApiKey || settings.cloudBaseUrl);
    }
    return !!settings.cloudApiKey;
  }

  /* Same result shape as the on-device engine: one entry per input, so a
     single bad string cannot take the page down with it. A thrown error means
     the whole batch failed and the caller should stop. */
  async function translateMany(settings, texts, source, target) {
    if (!texts.length) return [];
    const provider = PROVIDERS[settings.cloudProvider] || PROVIDERS.deepl;
    const translated = await provider(settings, texts, source, target);
    return translated.map(function (text) { return { ok: true, text }; });
  }

  HUEN.cloud = {
    translateMany,
    isConfigured,
    parseArray,
    systemPrompt,
    deeplBase,
    DEFAULTS,
  };
})(globalThis.HUEN);
