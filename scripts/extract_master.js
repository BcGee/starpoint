// Master-table extractor for the frozen World Flipper CDN snapshot.
//
// Pipeline (all inputs already on disk — no ADB/FFDEC/Electron needed):
//   1. boot_ffc6.as        → list of ~457 master-table paths ("path":"/...")
//   2. digest(path)        → SHA1(path + salt) hex   (wdfp-extractor digest.js)
//   3. entities CSV        → col1 "upload/<2>/<38>" (= digest) maps to col4 base64url file key
//   4. entities/files/<key>→ raw .orderedmap bytes → readOrderedMap → JSON
//
// Output: one JSON per master table under OUT_DIR, named by its original path
// (e.g. gacha/gacha.json). These feed converter.py (which reads scripts/in/<name>.json).
//
// Usage (on EC2, where the CDN lives):
//   node scripts/extract_master.js \
//     --boot   /path/to/boot_ffc6.as \
//     --csv    ~/starpoint/.cdn/ko/entities/<ver>-android_medium.csv \
//     --files  ~/starpoint/.cdn/ko/entities/files \
//     --out    ~/starpoint/scripts/in
//
// The CSV may not list every master table (some are android/common/medium variants);
// pass multiple --csv flags to merge several manifests.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readOrderedMap } = require('./_readOrderedMap');

// ---- args ----
const args = process.argv.slice(2);
function argVal(flag, def) {
  const all = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) all.push(args[i + 1]);
  return all.length ? all : (def === undefined ? [] : [def]);
}
const BOOT = argVal('--boot')[0];
const CSVS = argVal('--csv');
const FILES_DIR = argVal('--files')[0];
const OUT_DIR = argVal('--out')[0];

if (!BOOT || !CSVS.length || !FILES_DIR || !OUT_DIR) {
  console.error('missing args. need --boot --csv (1+) --files --out');
  process.exit(1);
}

// wdfp-extractor digest: SHA1(path + fixed salt)
const SALT = 'K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy';
const digest = (p) => crypto.createHash('sha1').update(p + SALT).digest('hex');

// ---- 1. parse master paths from boot_ffc6.as ----
const bootTxt = fs.readFileSync(BOOT, 'utf-8');
const paths = Array.from(bootTxt.matchAll(/"path":"([^"]*)"/g)).map((m) => m[1]);
const masterPaths = [...new Set(paths)].map(
  (p) => `master${p[0] === '/' ? p : `/${p}`}.orderedmap`
);
console.log(`boot_ffc6: ${masterPaths.length} unique master paths`);

// ---- 2. build digest → file-key map from CSV manifests ----
// CSV line: production/upload/<2>/<38>,<ver>,<size>,<base64url-key>,<type>
const digestToKey = {};
for (const csv of CSVS) {
  const txt = fs.readFileSync(csv, 'utf-8');
  let n = 0;
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 4) continue;
    const m = cols[0].match(/upload\/([0-9a-f]{2})\/([0-9a-f]+)$/);
    if (!m) continue;
    digestToKey[m[1] + m[2]] = cols[3];
    n++;
  }
  console.log(`csv ${path.basename(csv)}: ${n} entries`);
}
console.log(`total digest→key entries: ${Object.keys(digestToKey).length}`);

// ---- 3+4. resolve, decode, write ----
(async () => {
  let found = 0, missing = 0, failed = 0;
  const missingPaths = [];
  for (const mp of masterPaths) {
    const h = digest(mp);
    const key = digestToKey[h];
    if (!key) { missing++; missingPaths.push(mp); continue; }
    const filePath = path.join(FILES_DIR, key);
    if (!fs.existsSync(filePath)) { missing++; missingPaths.push(mp + ' (key not on disk)'); continue; }
    try {
      const buf = fs.readFileSync(filePath);
      const json = await readOrderedMap(buf);
      if (!json || Object.keys(json).length === 0) { failed++; continue; }
      // output name: strip "master/" prefix and ".orderedmap" suffix
      const rel = mp.replace(/^master\//, '').replace(/\.orderedmap$/, '');
      const outFile = path.join(OUT_DIR, rel + '.json');
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(json, null, 2));
      found++;
    } catch (e) {
      failed++;
      console.error(`decode fail ${mp}: ${e.message}`);
    }
  }
  console.log(`\n=== done: ${found} extracted, ${missing} missing, ${failed} failed ===`);
  if (missingPaths.length) {
    fs.writeFileSync(path.join(OUT_DIR, '_missing.txt'), missingPaths.join('\n'));
    console.log(`missing paths written to ${OUT_DIR}/_missing.txt (${missingPaths.length})`);
  }
})();
