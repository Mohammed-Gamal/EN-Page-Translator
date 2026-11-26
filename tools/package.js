#!/usr/bin/env node
/* Build the ZIP the Chrome Web Store wants, and refuse to build a bad one.

   The store needs manifest.json at the *root* of the archive, not inside a
   folder — the single most common reason a first upload bounces. Zipping the
   `extension` directory itself produces `extension/manifest.json` and is
   rejected, so this walks the directory and writes entries relative to it.

   It writes the archive by hand rather than shelling out. `Compress-Archive`
   is Windows-only, `zip` is not on Windows, and a dependency would be the
   first one this project has. Node has everything needed: `zlib.deflateRaw`
   for the compression and `zlib.crc32` for the checksum each entry carries.

   Usage:  npm run package            -> dist/<name>-<version>.zip
*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist');

/* Anything matching these never belongs in a published package. */
const EXCLUDE = [/(^|[\\/])\./, /\.map$/, /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])Thumbs\.db$/, /(^|[\\/])desktop\.ini$/];

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

/* ---------- the smallest ZIP writer that is still a correct ZIP ---------- */

function dosTime(date) {
  // MS-DOS packs the time into two 16-bit words, with two-second resolution
  // and years counted from 1980.
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) |
    (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) |
    date.getDate()) & 0xffff;
  return { time, day };
}

function buildZip(entries, stamp) {
  const { time, day } = dosTime(stamp);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.rel, 'utf8');
    const raw = fs.readFileSync(entry.full);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Storing beats deflating when the file is already compressed (the PNGs).
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: bit 11, the name is UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);             // extra length
    dir.writeUInt16LE(0, 32);             // comment length
    dir.writeUInt16LE(0, 34);             // disk number
    dir.writeUInt16LE(0, 36);             // internal attributes
    dir.writeUInt32LE(0o644 << 16, 38);   // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ---------- checks worth failing on, before anyone waits on a review ---- */

function check(entries, manifest) {
  const problems = [];
  const names = new Set(entries.map((e) => e.rel));

  if (!names.has('manifest.json')) {
    problems.push('manifest.json is not at the root of the archive');
  }
  if (!manifest.version) problems.push('the manifest has no version');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
    problems.push(`version "${manifest.version}" is not one to four dot-separated numbers`);
  }
  if (!names.has('icons/icon128.png')) {
    problems.push('the 128x128 icon is missing, and the store requires one');
  }
  if (manifest.default_locale && !names.has(`_locales/${manifest.default_locale}/messages.json`)) {
    problems.push(`default_locale is "${manifest.default_locale}" but its messages.json is not in the package`);
  }
  for (const target of Object.values(manifest.icons || {})) {
    if (!names.has(target)) problems.push(`the manifest points at a missing ${target}`);
  }
  return problems;
}

/* ---------- go ---------- */

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'manifest.json'), 'utf8'));
  const entries = walk(SOURCE, SOURCE, []);

  const problems = check(entries, manifest);
  if (problems.length) {
    console.error('Not packaging. The store would reject this:');
    for (const problem of problems) console.error('  - ' + problem);
    process.exit(1);
  }

  const zip = buildZip(entries, new Date());
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const stem = (require(path.join(ROOT, 'package.json')).name || 'extension');
  const target = path.join(OUT_DIR, `${stem}-${manifest.version}.zip`);
  fs.writeFileSync(target, zip);

  const kb = (zip.length / 1024).toFixed(1);
  console.log(`${path.relative(ROOT, target)}  (${entries.length} files, ${kb} KB)`);
  console.log(`version ${manifest.version} — the store rejects re-uploading a version it already has`);
}

main();
