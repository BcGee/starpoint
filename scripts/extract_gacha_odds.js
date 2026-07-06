// Extract gacha odds tables referenced by gacha.json.
//
// gacha.orderedmap rows reference odds tables by NAME (e.g. "star_heroes_6_character_5")
// in columns [14][15][16] (character rarity 3/4/5) and [22][23][24] (weapon).
// The actual odds live at master/gacha_odds/<name>.orderedmap — these are NOT listed
// in boot_ffc6.as, so extract_master.js misses them. This script gathers all odds
// names from the decoded gacha table and extracts each into <out>/gacha_odds/<name>.json.
//
// Usage (on EC2):
//   node scripts/extract_gacha_odds.js \
//     --gacha  scripts/in_extracted/gacha/gacha.json \
//     --csv    .cdn/ko/entities/2.1.121-android_medium.csv \
//     --files  .cdn/ko/entities/files \
//     --out    scripts/in_extracted/gacha_odds

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readOrderedMap } = require('./_readOrderedMap');

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const GACHA = val('--gacha');
const CSV = val('--csv');
const FILES_DIR = val('--files');
const OUT_DIR = val('--out');
if (!GACHA || !CSV || !FILES_DIR || !OUT_DIR) { console.error('need --gacha --csv --files --out'); process.exit(1); }

const SALT = 'K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy';
const digest = (p) => crypto.createHash('sha1').update(p + SALT).digest('hex');

// digest → base64url file key
const digestToKey = {};
for (const line of fs.readFileSync(CSV, 'utf-8').split('\n')) {
  if (!line) continue;
  const cols = line.split(',');
  if (cols.length < 4) continue;
  const m = cols[0].match(/upload\/([0-9a-f]{2})\/([0-9a-f]+)$/);
  if (m) digestToKey[m[1] + m[2]] = cols[3];
}

// collect odds names from gacha table columns 14,15,16,22,23,24
const gacha = JSON.parse(fs.readFileSync(GACHA, 'utf-8'));
const oddsNames = new Set();
for (const row of Object.values(gacha)) {
  for (const idx of [14, 15, 16, 22, 23, 24]) {
    const name = row[idx];
    if (name && name !== '(None)' && name.trim()) oddsNames.add(name.trim());
  }
}
console.log(`odds names referenced: ${oddsNames.size}`);

(async () => {
  let found = 0, missing = 0, failed = 0;
  const missingNames = [];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of oddsNames) {
    const mp = `master/gacha_odds/${name}.orderedmap`;
    const key = digestToKey[digest(mp)];
    if (!key) { missing++; missingNames.push(name); continue; }
    const fp = path.join(FILES_DIR, key);
    if (!fs.existsSync(fp)) { missing++; missingNames.push(name + ' (no file)'); continue; }
    try {
      const json = await readOrderedMap(fs.readFileSync(fp));
      if (!json || Object.keys(json).length === 0) { failed++; continue; }
      fs.writeFileSync(path.join(OUT_DIR, name + '.json'), JSON.stringify(json, null, 2));
      found++;
    } catch (e) { failed++; console.error(`fail ${name}: ${e.message}`); }
  }
  console.log(`\n=== odds: ${found} extracted, ${missing} missing, ${failed} failed ===`);
  if (missingNames.length) console.log('missing (first 20):', missingNames.slice(0, 20).join(', '));
})();
