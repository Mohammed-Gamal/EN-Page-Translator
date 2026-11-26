/* Tests for the cloud translation providers.

   Everything here runs against a fake `fetch`, so no request leaves the
   machine and no key is needed. What is worth testing is the part that breaks
   in practice: whether a model's reply can be turned back into one string per
   input, whether a provider's error codes are read correctly, and whether the
   key ever ends up somewhere it should not. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'extension', 'src');

/* ---------- a sandbox with a fetch we control ---------- */

function load(handler) {
  const calls = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
    async fetch(url, options) {
      calls.push({ url, options, body: options && options.body ? JSON.parse(options.body) : null });
      return handler(url, options, calls.length);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of [
    'shared/namespace.js', 'shared/protocol.js', 'shared/settings.js',
    'shared/languages.js', 'background/cloud.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'),
      sandbox, { filename: file });
  }
  return { HUEN: sandbox.HUEN, calls };
}

function reply(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (headers || {})[name] || null },
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function settings(HUEN, overrides) {
  return HUEN.normalizeSettings(Object.assign({ cloudApiKey: 'test-key' }, overrides));
}

/* ---------- DeepL ---------- */

test('DeepL gets the texts as an array and the answer is unpacked in order', async () => {
  const { HUEN, calls } = load(() => reply(200, {
    translations: [{ text: 'Contact' }, { text: 'Log in' }],
  }));
  const out = await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'deepl' }), ['Kapcsolat', 'Bejelentkezés'], 'hu', 'en');

  assert.deepStrictEqual(Array.from(out, (r) => r.text), ['Contact', 'Log in']);
  assert.ok(out.every((r) => r.ok));
  assert.deepStrictEqual(calls[0].body.text, ['Kapcsolat', 'Bejelentkezés']);
  assert.strictEqual(calls[0].body.source_lang, 'HU');
  assert.strictEqual(calls[0].body.target_lang, 'EN');
});

test('a free DeepL key goes to the free host, a pro key to the pro host', async () => {
  // Sending a :fx key to the pro host returns 403, which looks like a bad key
  // rather than the wrong host, so this is worth getting right.
  const free = load(() => reply(200, { translations: [{ text: 'x' }] }));
  await free.HUEN.cloud.translateMany(
    settings(free.HUEN, { cloudProvider: 'deepl', cloudApiKey: 'abc:fx' }), ['a'], 'hu', 'en');
  assert.match(free.calls[0].url, /api-free\.deepl\.com/);

  const pro = load(() => reply(200, { translations: [{ text: 'x' }] }));
  await pro.HUEN.cloud.translateMany(
    settings(pro.HUEN, { cloudProvider: 'deepl', cloudApiKey: 'abc' }), ['a'], 'hu', 'en');
  assert.match(pro.calls[0].url, /^https:\/\/api\.deepl\.com/);
});

test('an explicit endpoint overrides the host DeepL would be given', async () => {
  const { HUEN, calls } = load(() => reply(200, { translations: [{ text: 'x' }] }));
  await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'deepl', cloudBaseUrl: 'https://proxy.example/v2' }),
    ['a'], 'hu', 'en');
  assert.match(calls[0].url, /^https:\/\/proxy\.example\/v2\/translate$/);
});

test('a wrong number of translations back is an error, not silent corruption', async () => {
  const { HUEN } = load(() => reply(200, { translations: [{ text: 'only one' }] }));
  await assert.rejects(
    () => HUEN.cloud.translateMany(
      settings(HUEN, { cloudProvider: 'deepl' }), ['a', 'b'], 'hu', 'en'),
    /returned 1 translations for 2/);
});

/* ---------- error codes ---------- */

test('a rejected key is fatal, so the run stops instead of retrying', async () => {
  const { HUEN } = load(() => reply(403, 'Forbidden'));
  await assert.rejects(
    () => HUEN.cloud.translateMany(settings(HUEN, { cloudProvider: 'deepl' }), ['a'], 'hu', 'en'),
    (err) => {
      assert.strictEqual(err.code, HUEN.ERR.CLOUD_AUTH);
      assert.ok(HUEN.isFatalCode(err.code), 'a bad key must stop the page');
      return true;
    });
});

test('an exhausted quota is fatal too', async () => {
  const { HUEN } = load(() => reply(456, 'Quota exceeded'));
  await assert.rejects(
    () => HUEN.cloud.translateMany(settings(HUEN, { cloudProvider: 'deepl' }), ['a'], 'hu', 'en'),
    (err) => {
      assert.strictEqual(err.code, HUEN.ERR.CLOUD_QUOTA);
      assert.ok(HUEN.isFatalCode(err.code));
      return true;
    });
});

test('a transient failure is retried and is not fatal', async () => {
  let attempts = 0;
  const { HUEN } = load(() => {
    attempts++;
    return attempts < 3
      ? reply(503, 'busy')
      : reply(200, { translations: [{ text: 'Contact' }] });
  });
  const out = await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'deepl' }), ['Kapcsolat'], 'hu', 'en');
  assert.strictEqual(attempts, 3, 'should have retried twice before succeeding');
  assert.strictEqual(out[0].text, 'Contact');
  assert.ok(!HUEN.isFatalCode(HUEN.ERR.CLOUD_FAILED), 'a flaky network must not stop the page');
});

test('a server that never recovers gives up rather than looping', async () => {
  let attempts = 0;
  const { HUEN } = load(() => { attempts++; return reply(500, 'nope'); });
  await assert.rejects(() => HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'deepl' }), ['a'], 'hu', 'en'));
  assert.strictEqual(attempts, 3, 'three attempts, then stop');
});

/* ---------- OpenAI-compatible ---------- */

function chatReply(content) {
  return reply(200, { choices: [{ message: { content } }] });
}

test('a model reply is parsed into one string per input', async () => {
  const { HUEN, calls } = load(() => chatReply('["The dog","runs in the garden"]'));
  const out = await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'openai' }), ['A kutya', 'fut a kertben'], 'hu', 'en');

  assert.deepStrictEqual(Array.from(out, (r) => r.text), ['The dog', 'runs in the garden']);
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.strictEqual(calls[0].body.temperature, 0, 'translation wants determinism');
});

test('the prompt tells the model to preserve the markers', async () => {
  // The queue rebuilds sentences from these; a model that renames one costs
  // the page its markup.
  const prompt = HUEN_PROMPT();
  assert.match(prompt, /\{1\}/);
  assert.match(prompt, /\{\{G0\}\}/);
  assert.match(prompt, /native/i);
  assert.match(prompt, /register/i);
});

function HUEN_PROMPT() {
  const { HUEN } = load(() => chatReply('[]'));
  return HUEN.cloud.systemPrompt('Hungarian', 'English');
}

test('the prompt names the languages it was given', () => {
  const { HUEN } = load(() => chatReply('[]'));
  const prompt = HUEN.cloud.systemPrompt('German', 'English');
  assert.match(prompt, /German-to-English/);
});

test('a reply wrapped in a markdown fence is still read', async () => {
  const { HUEN } = load(() => chatReply('```json\n["Contact"]\n```'));
  const out = await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'openai' }), ['Kapcsolat'], 'hu', 'en');
  assert.strictEqual(out[0].text, 'Contact');
});

test('a reply with chatter around the array is still read', async () => {
  const { HUEN } = load(() => chatReply('Sure! Here you go:\n["Contact"]\nHope that helps.'));
  const out = await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'openai' }), ['Kapcsolat'], 'hu', 'en');
  assert.strictEqual(out[0].text, 'Contact');
});

test('an unusable reply falls back to one request per string', async () => {
  // Rather than lose the batch. It costs more, but only after the model has
  // already misbehaved.
  let call = 0;
  const { HUEN, calls } = load(() => {
    call++;
    if (call === 1) return chatReply('I cannot do that.');
    return chatReply(JSON.stringify(['one']));
  });
  const out = await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'openai' }), ['a', 'b'], 'hu', 'en');
  assert.strictEqual(calls.length, 3, 'one batch attempt, then one call per string');
  assert.deepStrictEqual(Array.from(out, (r) => r.text), ['one', 'one']);
});

test('parseArray refuses an array of the wrong length', () => {
  const { HUEN } = load(() => chatReply('[]'));
  assert.strictEqual(HUEN.cloud.parseArray('["a"]', 2), null);
  assert.strictEqual(HUEN.cloud.parseArray('not json', 1), null);
  assert.strictEqual(HUEN.cloud.parseArray('{"a":1}', 1), null);
  assert.deepStrictEqual(Array.from(HUEN.cloud.parseArray('["a","b"]', 2)), ['a', 'b']);
});

test('a local endpoint is allowed to have no key', async () => {
  const { HUEN, calls } = load(() => chatReply('["Contact"]'));
  const local = HUEN.normalizeSettings({
    cloudProvider: 'openai',
    cloudApiKey: '',
    cloudBaseUrl: 'http://localhost:11434/v1',
  });
  assert.ok(HUEN.cloud.isConfigured(local), 'a base URL alone is enough locally');
  await HUEN.cloud.translateMany(local, ['Kapcsolat'], 'hu', 'en');
  assert.strictEqual(calls[0].options.headers.Authorization, undefined,
    'no key means no Authorization header, not an empty one');
});

/* ---------- configuration and the key ---------- */

test('DeepL without a key is not configured and does not call out', async () => {
  const { HUEN, calls } = load(() => chatReply('[]'));
  const bare = HUEN.normalizeSettings({ cloudProvider: 'deepl', cloudApiKey: '' });
  assert.ok(!HUEN.cloud.isConfigured(bare));
  await assert.rejects(() => HUEN.cloud.translateMany(bare, ['a'], 'hu', 'en'),
    (err) => err.code === HUEN.ERR.CLOUD_AUTH);
  assert.strictEqual(calls.length, 0, 'nothing should have been sent');
});

test('the key goes in a header, never in the URL', async () => {
  const { HUEN, calls } = load(() => reply(200, { translations: [{ text: 'x' }] }));
  await HUEN.cloud.translateMany(
    settings(HUEN, { cloudProvider: 'deepl', cloudApiKey: 'secret-key' }), ['a'], 'hu', 'en');
  assert.ok(!calls[0].url.includes('secret-key'),
    'a key in a URL ends up in logs and history');
  assert.strictEqual(calls[0].options.headers.Authorization, 'DeepL-Auth-Key secret-key');
});

test('a failure message does not quote the key back', async () => {
  const { HUEN } = load(() => reply(400, 'Bad request for key secret-key'));
  await assert.rejects(
    () => HUEN.cloud.translateMany(
      settings(HUEN, { cloudProvider: 'deepl', cloudApiKey: 'secret-key' }), ['a'], 'hu', 'en'),
    (err) => {
      // The body is echoed for diagnosis, so this guards the one case where
      // that would leak: the service repeating the key back at us.
      assert.ok(!err.message.includes('secret-key'),
        'the key must not travel back out in an error shown to the user');
      return true;
    });
});

/* ---------- settings ---------- */

test('an unknown provider or engine falls back to the default', () => {
  const { HUEN } = load(() => chatReply('[]'));
  assert.strictEqual(HUEN.normalizeSettings({ engine: 'magic' }).engine, 'auto');
  assert.strictEqual(HUEN.normalizeSettings({ cloudProvider: 'magic' }).cloudProvider, 'deepl');
});

test('a base URL that is not http(s) is discarded', () => {
  const { HUEN } = load(() => chatReply('[]'));
  // Otherwise it would be a way to point the key at something unexpected.
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example', 'nonsense']) {
    assert.strictEqual(HUEN.normalizeSettings({ cloudBaseUrl: bad }).cloudBaseUrl, '', bad);
  }
  assert.strictEqual(
    HUEN.normalizeSettings({ cloudBaseUrl: 'https://api.example/v1/' }).cloudBaseUrl,
    'https://api.example/v1');
});

test('the key is trimmed, because pasted keys carry whitespace', () => {
  const { HUEN } = load(() => chatReply('[]'));
  assert.strictEqual(HUEN.normalizeSettings({ cloudApiKey: '  abc:fx \n' }).cloudApiKey, 'abc:fx');
});
