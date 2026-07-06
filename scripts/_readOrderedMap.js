// Dependency-free port of wdfp-extractor's readOrderedMap.js
// (original uses csv-parse/sync; here we inline a minimal CSV row parser since
// orderedmap leaf values are simple comma-separated records without embedded
// newlines in quoted fields for the master tables we target).
//
// orderedmap binary format:
//   [int32 headerSize][zlib(header)][content]
//   header: [int32 entriesCount][ (int32 keyEndOff, int32 dataEndOff) * N ][ keys... ]
//   content: N segments, each zlib-compressed CSV OR a nested orderedmap.

const zlib = require('zlib');

const asyncUnzip = (buf) =>
  new Promise((resolve, reject) =>
    zlib.unzip(buf, (err, res) => (err ? reject(err) : resolve(res)))
  );

// Minimal CSV parser: splits on newlines, then commas, honoring double-quote
// escaping. Flattens all rows into a single array (matches wdfp-extractor's
// parseCsv reduce behavior).
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // skip
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // flatten (orderedmap leaf values are typically single-row records)
  return rows.reduce((acc, cur) => acc.concat(cur), []);
}

const readOrderedMap = async (mapping) => {
  // Case A: whole file is just a zlib blob (simple table)
  try {
    const rawUnzipped = await asyncUnzip(mapping);
    return parseCsv(rawUnzipped.toString('utf-8'));
  } catch (err) { /* fall through to structured format */ }

  try {
    const headerSize = mapping.readInt32LE(0);
    const zlibCompressedHeader = mapping.slice(4, headerSize + 4);
    const uncompressedHeader = await asyncUnzip(zlibCompressedHeader);

    const entriesCount = uncompressedHeader.readInt32LE(0);
    const entryOffsetsBuffer = uncompressedHeader.slice(4, entriesCount * 8 + 4);
    const entryOffsets = new Array(entriesCount).fill().map((_, idx) => [
      entryOffsetsBuffer.readInt32LE(idx * 8),
      entryOffsetsBuffer.readInt32LE(idx * 8 + 4),
    ]);

    let currentKeyOffset = 0;
    const keysBuffer = uncompressedHeader.slice(entriesCount * 8 + 4);
    const keys = entryOffsets.map(([keyEndOffset]) => {
      const k = keysBuffer.slice(currentKeyOffset, keyEndOffset);
      currentKeyOffset = keyEndOffset;
      return k.toString('utf-8');
    });

    const contentSection = mapping.slice(4 + headerSize);
    let currentOffset = 0;
    const contents = entryOffsets.map(([, dataOffset]) => {
      const c = contentSection.slice(currentOffset, dataOffset);
      currentOffset = dataOffset;
      return c;
    });

    const values = await Promise.all(
      contents.map(async (content) => {
        try {
          const unzipped = await asyncUnzip(content);
          return unzipped.toString('utf-8');
        } catch (err) {
          return readOrderedMap(content); // nested orderedmap
        }
      })
    );

    return keys.reduce((acc, key, index) => {
      acc[key] = typeof values[index] === 'string' ? parseCsv(values[index]) : values[index];
      return acc;
    }, {});
  } catch (err) {
    return {};
  }
};

module.exports = { readOrderedMap };
