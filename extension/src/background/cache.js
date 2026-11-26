/* The persistent translation cache.

   Site chrome repeats relentlessly: "Bejelentkezés", "Kapcsolat", "Tovább a
   részletekhez" appear on every page of a site. Remembering them turns the
   second page the reader visits on a domain into mostly cache hits, which is
   the single biggest reason the extension feels fast.

   This lives in IndexedDB rather than chrome.storage.local. storage.local
   offers no way to enumerate keys, so counting entries, measuring them or
   pruning them all meant reading the entire store into memory — tens of
   thousands of records to answer "how many are there?". IndexedDB counts
   without reading, and an index on last-use turns pruning into a cursor that
   walks exactly as far as it needs to.

   That index is also what makes the eviction policy honest. Recording a use
   costs a write, and reads are the hot path, so a hit only refreshes its
   timestamp when the one on record is already a day old: near-LRU accuracy at
   roughly one write per entry per day. */
(function (HUEN) {
  'use strict';

  const DB_NAME = 'huen-cache';
  const DB_VERSION = 1;
  const STORE = 'phrases';
  const USED_INDEX = 'used';

  /* Don't rewrite a record's timestamp more often than this. */
  const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
  /* Take the cache this far below the limit when pruning, so a cache sitting
     exactly at the cap does not prune on every single write. */
  const PRUNE_TO = 0.9;
  /* Measuring every record would defeat the point of counting cheaply. */
  const SAMPLE_SIZE = 300;

  /* The legacy chrome.storage.local layout, migrated once on first use. */
  const LEGACY_PREFIX = 'c:';
  const MIGRATED_FLAG = 'cacheMigratedToIdb';

  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'k' });
          store.createIndex(USED_INDEX, 'u');
        }
      };
      request.onsuccess = function () {
        const db = request.result;
        /* A service worker is torn down and restarted constantly; drop the
           handle rather than block a version change from another context. */
        db.onversionchange = function () {
          db.close();
          opening = null;
        };
        db.onclose = function () { opening = null; };
        resolve(db);
      };
      request.onerror = function () {
        opening = null;
        reject(request.error);
      };
    });
    return opening;
  }

  function tx(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function done(store) {
    return new Promise(function (resolve, reject) {
      store.transaction.oncomplete = function () { resolve(); };
      store.transaction.onerror = function () { reject(store.transaction.error); };
      store.transaction.onabort = function () { reject(store.transaction.error); };
    });
  }

  /* ---------- reading ---------- */

  async function get(keys) {
    if (!Array.isArray(keys) || !keys.length) return {};
    await migrateOnce();

    let db;
    try {
      db = await open();
    } catch (_) {
      return {}; // a cache that will not open is a slow cache, not a broken one
    }

    const store = tx(db, 'readonly');
    const records = await Promise.all(keys.map(function (key) {
      return wrap(store.get(key)).catch(function () { return undefined; });
    }));

    const hits = {};
    const stale = [];
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const record = records[i];
      if (!record || typeof record.v !== 'string') continue;
      hits[keys[i]] = record.v;
      if (now - (record.u || 0) > TOUCH_AFTER_MS) stale.push(record);
    }

    if (stale.length) touch(db, stale, now);
    return hits;
  }

  /* Fire and forget: the caller already has its answer, and a failed
     timestamp refresh only costs eviction accuracy. */
  function touch(db, records, now) {
    try {
      const store = tx(db, 'readwrite');
      for (const record of records) {
        record.u = now;
        store.put(record);
      }
    } catch (_) { /* the transaction could not start; nothing is lost */ }
  }

  /* ---------- writing ---------- */

  async function put(entries, limit) {
    if (!Array.isArray(entries) || !entries.length) return;
    await migrateOnce();

    let db;
    try {
      db = await open();
    } catch (_) {
      return;
    }

    const now = Date.now();
    const store = tx(db, 'readwrite');
    let added = 0;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [key, value] = entry;
      if (typeof key !== 'string' || typeof value !== 'string' || !key || !value) continue;
      store.put({ k: key, v: value, u: now });
      added++;
    }
    if (!added) return;
    await done(store);

    /* Counting is cheap now, so the check is exact rather than sampled. */
    const cap = Number(limit) || 20000;
    const total = await count();
    if (total > cap) await prune(cap);
  }

  async function count() {
    const db = await open();
    return wrap(tx(db, 'readonly').count());
  }

  /* Walk the least-recently-used end of the index and delete until the cache
     is back under the limit. Nothing else is read. */
  async function prune(limit) {
    const cap = Math.max(1, Number(limit) || 20000);
    const db = await open();
    const total = await wrap(tx(db, 'readonly').count());
    let excess = total - Math.floor(cap * PRUNE_TO);
    if (excess <= 0) return 0;

    const removed = excess;
    const store = tx(db, 'readwrite');
    await new Promise(function (resolve, reject) {
      const request = store.index(USED_INDEX).openCursor();
      request.onsuccess = function () {
        const cursor = request.result;
        if (!cursor || excess <= 0) return resolve();
        cursor.delete();
        excess--;
        cursor.continue();
      };
      request.onerror = function () { reject(request.error); };
    });
    await done(store);
    return removed;
  }

  /* ---------- housekeeping ---------- */

  async function stats() {
    let db;
    try {
      db = await open();
    } catch (_) {
      return { entries: 0, bytes: 0, sampled: false };
    }
    const entries = await wrap(tx(db, 'readonly').count());
    if (!entries) return { entries: 0, bytes: 0, sampled: false };

    /* Average the first few hundred records and extrapolate. Reading every
       record to add up its length is exactly the full scan this store exists
       to avoid, and the number is only ever shown as "about". */
    let sampled = 0;
    let bytes = 0;
    const store = tx(db, 'readonly');
    await new Promise(function (resolve) {
      const request = store.openCursor();
      request.onsuccess = function () {
        const cursor = request.result;
        if (!cursor || sampled >= SAMPLE_SIZE) return resolve();
        const record = cursor.value;
        bytes += String(record.k).length + String(record.v).length;
        sampled++;
        cursor.continue();
      };
      request.onerror = function () { resolve(); };
    });

    const average = sampled ? bytes / sampled : 0;
    return {
      entries,
      bytes: Math.round(average * entries),
      sampled: sampled < entries,
    };
  }

  async function clear() {
    let db;
    try {
      db = await open();
    } catch (_) {
      return 0;
    }
    const removed = await wrap(tx(db, 'readonly').count());
    const store = tx(db, 'readwrite');
    store.clear();
    await done(store);
    return removed;
  }

  /* ---------- migration from chrome.storage.local ---------- */

  let migration = null;

  /* Existing installs have their cache in storage.local under a "c:" prefix.
     Move it across once, then get out of the way. Reading all of storage.local
     is the expensive operation this rewrite exists to stop doing — so it
     happens exactly once, guarded by a flag, and the old keys are deleted
     whether or not every record made it. */
  function migrateOnce() {
    if (migration) return migration;
    migration = (async function () {
      let flag;
      try {
        flag = await chrome.storage.local.get([MIGRATED_FLAG]);
      } catch (_) {
        return;
      }
      if (flag && flag[MIGRATED_FLAG]) return;

      try {
        const all = await chrome.storage.local.get(null);
        const legacy = Object.keys(all).filter(function (key) {
          return key.startsWith(LEGACY_PREFIX);
        });

        if (legacy.length) {
          const db = await open();
          const now = Date.now();
          const store = tx(db, 'readwrite');
          for (const key of legacy) {
            const value = all[key];
            if (typeof value !== 'string') continue;
            store.put({ k: key.slice(LEGACY_PREFIX.length), v: value, u: now });
          }
          await done(store);
          await chrome.storage.local.remove(legacy.concat(['cacheCount']));
        }
        await chrome.storage.local.set({ [MIGRATED_FLAG]: true });
      } catch (_) {
        // Leave the flag unset so the next start tries again.
        migration = null;
      }
    })();
    return migration;
  }

  HUEN.cache = { get, put, prune, stats, clear, count, migrateOnce };
})(globalThis.HUEN);
