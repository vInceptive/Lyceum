// Reads a Mobipocket (.mobi/.prc) dictionary entirely in the browser.
// The file is never uploaded — it is picked with a file input, parsed once,
// and the resulting index + text stream are cached in IndexedDB so later
// sessions are instant and fully offline.
//
// Supported: PalmDOC (LZ77) and HUFF/CDIC compression, MOBI6 orthographic
// (ORTH) INDX indices. DRM'd files (Amazon-supplied dictionaries) cannot be
// opened and report as such.

const DB = 'visible-dict';
const STORE = 'dicts';

function openDb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE);
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((res, rej) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  } catch (e) { return null; }
}

async function idbPut(key, val) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch (e) { return false; }
}

export const PARSER_VERSION = 11;

export async function cachedDictionaries() {
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
  } catch (e) { return []; }
}

export async function forgetDictionaries() {
  try {
    const db = await openDb();
    await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch (e) { /* nothing cached */ }
}

/* ---------- little-helpers over the byte buffer ---------- */

const u16 = (d, o) => d.getUint16(o, false);
const u32 = (d, o) => d.getUint32(o, false);

function ascii(bytes, o, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[o + i]);
  return s;
}

// MOBI index values are big-endian base-128; the high bit marks the last byte.
function varint(bytes, off) {
  let v = 0;
  for (;;) {
    const b = bytes[off++];
    v = (v << 7) | (b & 0x7f);
    if (b & 0x80) return [v, off];
  }
}

function countBits(m) { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; }

/* ---------- PalmDOC / LZ77 ---------- */

function palmDoc(src) {
  const out = new Uint8Array(8192);
  let o = 0, i = 0;
  const push = (b) => { if (o < out.length) out[o++] = b; };
  while (i < src.length) {
    const c = src[i++];
    if (c === 0) push(0);
    else if (c <= 8) { for (let k = 0; k < c && i < src.length; k++) push(src[i++]); }
    else if (c <= 0x7f) push(c);
    else if (c <= 0xbf) {
      const d = ((c << 8) | src[i++]) & 0x3fff;
      const dist = d >> 3, len = (d & 7) + 3;
      for (let k = 0; k < len; k++) { const p = o - dist; push(p >= 0 ? out[p] : 0); }
    } else { push(32); push(c ^ 0x80); }
  }
  return out.subarray(0, o);
}

/* ---------- HUFF / CDIC ---------- */

class Huff {
  constructor(huffRec, cdicRecs) {
    const d = new DataView(huffRec.buffer, huffRec.byteOffset, huffRec.byteLength);
    if (ascii(huffRec, 0, 4) !== 'HUFF') throw new Error('bad HUFF record');
    const off1 = u32(d, 8), off2 = u32(d, 12);
    this.dict1 = new Array(256);
    for (let i = 0; i < 256; i++) {
      const v = u32(d, off1 + i * 4);
      const codelen = v & 0x1f, term = v & 0x80;
      let maxcode = v >>> 8;
      maxcode = (((maxcode + 1) * Math.pow(2, 32 - codelen)) - 1);
      this.dict1[i] = [codelen, term, maxcode];
    }
    this.mincode = new Array(32);
    this.maxcode = new Array(32);
    for (let i = 0; i < 32; i++) {
      const mn = u32(d, off2 + i * 8), mx = u32(d, off2 + i * 8 + 4);
      this.mincode[i] = mn * Math.pow(2, 32 - i);
      this.maxcode[i] = ((mx + 1) * Math.pow(2, 32 - i)) - 1;
    }
    this.dictionary = [];
    for (const rec of cdicRecs) {
      const cd = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
      if (ascii(rec, 0, 4) !== 'CDIC') throw new Error('bad CDIC record');
      const phrases = u32(cd, 8), bits = u32(cd, 12);
      const n = Math.min(1 << bits, phrases - this.dictionary.length);
      for (let i = 0; i < n; i++) {
        const off = u16(cd, 16 + i * 2);
        const blen = u16(cd, 16 + off);
        const len = blen & 0x7fff;
        this.dictionary.push([rec.subarray(16 + off + 2, 16 + off + 2 + len), (blen & 0x8000) !== 0]);
      }
    }
  }

  unpack(data) {
    const chunks = [];
    let total = 0;
    const padded = new Uint8Array(data.length + 8);
    padded.set(data);
    const dv = new DataView(padded.buffer);
    let bitsleft = data.length * 8, pos = 0, n = 32;
    let hi = dv.getUint32(0), lo = dv.getUint32(4);
    for (;;) {
      if (n <= 0) {
        pos += 4;
        hi = dv.getUint32(pos);
        lo = dv.getUint32(pos + 4);
        n += 32;
      }
      // (x >>> n) & 0xffffffff over the 64-bit word hi:lo, done in exact 32-bit ops.
      const code = n === 32 ? hi : (((hi << (32 - n)) | (lo >>> n)) >>> 0);
      let [codelen, term, maxcode] = this.dict1[Math.floor(code / 16777216)];
      if (!term) {
        while (code < this.mincode[codelen]) codelen++;
        maxcode = this.maxcode[codelen];
      }
      n -= codelen;
      bitsleft -= codelen;
      if (bitsleft < 0) break;
      const r = Math.floor((maxcode - code) / Math.pow(2, 32 - codelen));
      const slot = this.dictionary[r];
      if (!slot) break;
      let [slice, flag] = slot;
      if (!flag) {
        slot[0] = new Uint8Array(0);
        slice = this.unpack(slice);
        slot[0] = slice;
        slot[1] = true;
      }
      chunks.push(slice);
      total += slice.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/* ---------- trailing byte entries appended to each text record ---------- */

function trailingSize(rec, size, flags) {
  const one = (end) => {
    let bitpos = 0, result = 0, s = end;
    if (s <= 0) return 0;
    for (;;) {
      const v = rec[s - 1];
      result |= (v & 0x7f) << bitpos;
      bitpos += 7;
      s -= 1;
      if ((v & 0x80) !== 0 || bitpos >= 28 || s === 0) return result;
    }
  };
  let num = 0, t = flags >> 1;
  while (t) {
    if (t & 1) num += one(size - num);
    t >>= 1;
  }
  if (flags & 1) num += (rec[size - num - 1] & 0x3) + 1;
  return num;
}

/* ---------- INDX parsing ---------- */

function parseTagx(rec, at) {
  const d = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  if (ascii(rec, at, 4) !== 'TAGX') return null;
  const len = u32(d, at + 4);
  const controlBytes = u32(d, at + 8);
  const table = [];
  for (let o = at + 12; o < at + len; o += 4) {
    table.push([rec[o], rec[o + 1], rec[o + 2], rec[o + 3]]);
  }
  return { controlBytes, table };
}

function tagMap(controlBytes, table, bytes, start, end) {
  const found = [];
  let ctrl = 0, dataStart = start + controlBytes;
  for (const [tag, valuesPerEntry, maskIn, endFlag] of table) {
    if (endFlag === 0x01) { ctrl++; continue; }
    let mask = maskIn;
    let value = bytes[start + ctrl] & mask;
    if (value === mask) {
      if (countBits(mask) > 1) {
        let n;
        [n, dataStart] = varint(bytes, dataStart);
        found.push([tag, null, n, valuesPerEntry]);
      } else {
        found.push([tag, 1, null, valuesPerEntry]);
      }
    } else {
      while ((mask & 1) === 0) { mask >>= 1; value >>= 1; }
      found.push([tag, value, null, valuesPerEntry]);
    }
  }
  const out = {};
  for (const [tag, valueCount, valueBytes, valuesPerEntry] of found) {
    const values = [];
    if (valueCount !== null) {
      for (let i = 0; i < valueCount * valuesPerEntry; i++) {
        let v; [v, dataStart] = varint(bytes, dataStart);
        values.push(v);
      }
    } else {
      let consumed = 0;
      while (consumed < valueBytes) {
        const before = dataStart;
        let v; [v, dataStart] = varint(bytes, dataStart);
        consumed += dataStart - before;
        values.push(v);
      }
    }
    out[tag] = values;
  }
  return out;
}

function indxEntries(rec, tagx, decode, tagxOfs) {
  const d = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const headerLen = u32(d, 4);
  const idxtStart = u32(d, 20);
  const count = u32(d, 24);
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(u16(d, idxtStart + 4 + i * 2));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const start = offsets[i];
    const end = i + 1 < count ? offsets[i + 1] : idxtStart;
    const textLen = rec[start];
    const text = decode(rec.subarray(start + 1, start + 1 + textLen));
    const tags = tagMap(tagx.controlBytes, tagx.table, rec, start + 1 + textLen, end);
    rows.push([text, tags]);
  }
  return rows;
}

/* ---------- the dictionary ---------- */

const NOISE = /^(br|webster|wordnet|pjc|rj|nbsp|amp|ets|hw)$/;
// Webster's diacritic respelling leaks through as tokens like "oocr", "icr".
const PRON = /^[aeiouy]{1,2}(cr|macr|breve|circ|tilde|dieresis|dot|slash|hook)$/;
const POS = /^(n|a|v|adv|adj|prep|conj|interj|pron|pl|sing|imp|p)\.$/i;
const ENTITY = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–' };

const AMP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '’', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', nbsp: ' ' };
const unamp = (s) => s.replace(/&(#?\w+);/g, (all, k) =>
  k[0] === '#' ? String.fromCodePoint(Number(k[1] === 'x' ? '0' + k.slice(1) : k.slice(1)) || 32) : (AMP[k.toLowerCase()] || ' '));

// Scanned off the raw string rather than through DOMParser on purpose: the DOM
// silently collapses this file's duplicated attributes ("to jolt to jounce"
// loses its second "to"), and those attribute names ARE the definition text.
function scan(html, onText, onTag) {
  const re = /<([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[2] !== undefined) { onText(unamp(m[2])); continue; }
    const inner = m[1];
    const nm = inner.match(/^\/?\s*([a-z0-9:_-]+)/i);
    if (onTag(nm ? nm[1].toLowerCase() : '', inner) === false) return;
  }
}

function entryText(html) {
  const out = [];
  let skip = 0;
  scan(html, (t) => { if (!skip) out.push(t); }, (name, inner) => {
    const closing = inner[0] === '/';
    if (/^(script|style|idx:infl|infl|idx:iform|iform)$/.test(name)) {
      if (closing) skip = Math.max(0, skip - 1);
      else if (!/\/\s*$/.test(inner)) skip += 1;
      return;
    }
    if (skip) return;
    if (closing) {
      if (/^(p|div|li|blockquote)$/.test(name)) out.push('\u0000');
      return;
    }
    const ar = /([a-z0-9:._'’-]+)\s*=\s*"([^"]*)"/gi;
    let a;
    while ((a = ar.exec(inner))) {
      if (a[2] !== '') continue;
      const k = a[1];
      if (ENTITY[k]) { out.push(ENTITY[k]); continue; }
      if (NOISE.test(k) || PRON.test(k)) continue;
      out.push(k);
    }
    if (/^(p|div|li|br|blockquote)$/.test(name)) out.push('\u0000');
  });
  return out.join(' ')
    .replace(/[ \t]+/g, ' ')
    .split('\u0000')
    .map((s) => s.replace(/\s+([,.;:)\]])/g, '$1').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// The headword is the first plain-text run before the entry body opens. Reading
// descendant text first would pick up the etymology instead (indexing
// "Bibliographer" under "book").
function headwordOf(html) {
  const orth = html.match(/<idx:orth\b[^>]*\bvalue="([^"]+)"/i);
  if (orth) return orth[1].trim();
  let found = '';
  scan(html, (t) => {
    if (found) return;
    const hit = t.trim().match(/^[\p{L}][\p{L}\p{M}'’ -]*/u);
    if (hit) found = hit[0].replace(/[\s-]+$/, '');
  }, (name, inner) => {
    if (inner[0] === '/') return;
    if (/^(p|div|blockquote)$/.test(name)) return false;
  });
  return found;
}

// The entry body opens with the headword minus its first letter, sometimes split
// across several attributes ("rini", "trocellulose"). Drop that echo once.
function dedupeHead(part, headword) {
  const tail = (headword || '').slice(1).toLowerCase().replace(/[^\p{L}]/gu, '');
  if (!tail) return part;
  let squashed = '', i = 0;
  while (i < part.length && squashed.length < tail.length) {
    const ch = part[i++];
    if (/[\p{L}]/u.test(ch)) squashed += ch.toLowerCase();
    else if (!/[\s-]/.test(ch)) return part;
  }
  return squashed === tail ? part.slice(i).replace(/^[\s,;:]+/, '') : part;
}

// What survives of the pronunciation is a short run of consonant fragments
// before the part-of-speech marker. Cut to the marker when one is close by.
function trimPron(part) {
  const w = part.split(' ');
  const at = w.findIndex((t) => POS.test(t));
  if (at > 0 && at <= 5) return w.slice(at).join(' ');
  return part;
}

// Entry shape is: headword, part of speech, [etymology], then the numbered
// senses. Lead with the senses — the etymology is not what a reader wants from
// a double-click.
function stripHtml(html, headword) {
  const parts = entryText(html).filter((p) => p && p !== headword);
  if (!parts.length) return [];
  parts[0] = trimPron(dedupeHead(parts[0], headword));
  let all = parts.join(' ').replace(/\s+/g, ' ').trim();

  const pm = all.match(/^((?:(?:n|a|v|adv|adj|prep|conj|interj|pron|pl|sing|imp|obs|p|t|i|vb)\.\s+){1,5})/i);
  const pos = pm ? pm[1].trim().replace(/\s+/g, ' ') : '';
  if (pm) all = all.slice(pm[1].length);

  // A numbered sense is the surest start of the definition proper; otherwise the
  // etymology runs to its closing bracket.
  const numbered = all.search(/(^|\s)1\.\s/);
  const close = all.indexOf(']');
  if (numbered >= 0 && numbered < 2600) all = all.slice(numbered);
  else if (close >= 0 && close < 1200) all = all.slice(close + 1);
  all = all.replace(/^[\s,;:.\]]+/, '');

  const out = all.split(/\s(?=\d{1,2}\.\s)/)
    .map((s) => s.replace(/^\d{1,2}\.\s*/, '').replace(/\s+([,.;:)\]])/g, '$1').trim())
    .filter((s) => s.length > 1);
  if (!out.length && all.trim().length > 1) out.push(all.trim());
  return out.map((text, i) => ({ pos: i === 0 ? pos : '', text }));
}

const SUFFIXES = [
  ['ies', 'y'], ['ied', 'y'], ['ying', 'ie'], ['sses', 'ss'], ['ches', 'ch'], ['shes', 'sh'],
  ['xes', 'x'], ['zes', 'z'], ['ves', 'f'], ['s', ''], ['es', ''], ['ed', ''], ['ed', 'e'],
  ['ing', ''], ['ing', 'e'], ['er', ''], ['er', 'e'], ['est', ''], ['est', 'e'],
  ['ly', ''], ['ness', ''], ['ing', 'ing']
];

class MobiDictionary {
  constructor(name, text, index, encoding) {
    this.name = name;
    this.text = text;
    this.index = index;
    this.encoding = encoding;
    this.decoder = new TextDecoder(encoding);
    this.count = index.size;
  }

  candidates(word) {
    const w = String(word || '').toLowerCase().replace(/[^a-z' -]/g, '').replace(/\s+/g, ' ').trim();
    if (!w) return [];
    const out = [w];
    for (const [suf, rep] of SUFFIXES) {
      if (w.length > suf.length + 1 && w.endsWith(suf)) {
        const stem = w.slice(0, w.length - suf.length) + rep;
        if (stem.length > 1) out.push(stem);
        // undo doubled consonant: "riffled" -> "riffle", "running" -> "run"
        if (/([bdfglmnprt])\1$/.test(stem)) out.push(stem.slice(0, -1));
      }
    }
    return [...new Set(out)];
  }

  lookup(word) {
    for (const key of this.candidates(word)) {
      const hit = this.index.get(key);
      if (!hit) continue;
      const [off, len] = hit;
      const raw = this.text.subarray(off, off + len);
      const html = this.decoder.decode(raw);
      const senses = stripHtml(html, headwordOf(html));
      if (senses.length) return { headword: key, senses };
    }
    return null;
  }
}

function reviveIndex(flat) {
  const m = new Map();
  const { words, offs, lens } = flat;
  for (let i = 0; i < words.length; i++) m.set(words[i], [offs[i], lens[i]]);
  return m;
}

function flattenIndex(map) {
  const words = [], offs = [], lens = [];
  for (const [k, v] of map) { words.push(k); offs.push(v[0]); lens.push(v[1]); }
  return { words, offs: Int32Array.from(offs), lens: Int32Array.from(lens) };
}

export async function loadMobiDictionary(file, onProgress) {
  const PARSER = 11;
  const key = file.name + ':' + file.size + ':v' + PARSER;
  const say = (m, pct) => { if (onProgress) onProgress(m, pct); };

  const cached = await idbGet(key);
  if (cached && cached.text && cached.index) {
    say('Loading cached index…', 0.9);
    return new MobiDictionary(cached.name, new Uint8Array(cached.text), reviveIndex(cached.index), cached.encoding);
  }

  say('Reading ' + file.name + '…', 0.02);
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);

  const type = ascii(buf, 60, 8);
  if (type !== 'BOOKMOBI' && type !== 'TEXtREAd') throw new Error('not a Mobipocket file');

  const nrec = u16(dv, 76);
  const bounds = [];
  for (let i = 0; i < nrec; i++) bounds.push(u32(dv, 78 + i * 8));
  bounds.push(buf.length);
  const rec = (i) => buf.subarray(bounds[i], bounds[i + 1]);

  const r0 = rec(0);
  const d0 = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
  const compression = u16(d0, 0);
  const textRecords = u16(d0, 8);
  const encryption = u16(d0, 12);
  if (encryption !== 0) throw new Error('this dictionary is DRM-protected and cannot be opened');

  if (ascii(r0, 16, 4) !== 'MOBI') throw new Error('missing MOBI header');
  const mobiLen = u32(d0, 20);
  const textEncoding = u32(d0, 28) === 65001 ? 'utf-8' : 'windows-1252';
  const orthIndex = u32(d0, 40);
  const huffOff = mobiLen >= 116 ? u32(d0, 112) : 0;
  const huffCount = mobiLen >= 120 ? u32(d0, 116) : 0;
  const extraFlags = mobiLen >= 228 ? u16(d0, 242) : 0;

  if (orthIndex === 0xffffffff || orthIndex === 0) {
    throw new Error('no dictionary index in this file — it looks like a book, not a dictionary');
  }

  let huff = null;
  if (compression === 17480) {
    if (!huffCount) throw new Error('HUFF-compressed but no Huffman records');
    const cdics = [];
    for (let i = 1; i < huffCount; i++) cdics.push(rec(huffOff + i));
    say('Building Huffman tables…', 0.06);
    huff = new Huff(rec(huffOff), cdics);
  } else if (compression !== 1 && compression !== 2) {
    throw new Error('unsupported compression type ' + compression);
  }

  // Decompress the whole text stream. Dictionary entry offsets are absolute
  // positions in this concatenated stream, so it has to be built in full once.
  const chunks = [];
  let total = 0;
  for (let i = 1; i <= textRecords; i++) {
    let r = rec(i);
    if (extraFlags) r = r.subarray(0, r.length - trailingSize(r, r.length, extraFlags));
    let out;
    if (compression === 1) out = r;
    else if (compression === 2) out = palmDoc(r);
    else out = huff.unpack(r);
    chunks.push(out);
    total += out.length;
    if (i % 200 === 0) {
      say('Decompressing text… ' + Math.round((i / textRecords) * 100) + '%', 0.06 + 0.6 * (i / textRecords));
      await new Promise((r2) => setTimeout(r2, 0));
    }
  }
  const text = new Uint8Array(total);
  {
    let o = 0;
    for (const c of chunks) { text.set(c, o); o += c.length; }
  }

  say('Reading headword index…', 0.7);
  const head = rec(orthIndex);
  const hd = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (ascii(head, 0, 4) !== 'INDX') throw new Error('malformed dictionary index');
  const headerLen = u32(hd, 4);
  const indexCount = u32(hd, 24);
  const indexEncoding = u32(hd, 28) === 65001 ? 'utf-8' : 'windows-1252';

  // Headword bytes are not plain text in every dictionary: when the header
  // declares an ORDT2 table each byte indexes a codepoint in it. Skipping this
  // yields mojibake keys that no lookup can ever match.
  let ordt2 = null, tagxOfs = headerLen;
  if (headerLen >= 0xb8) {
    const ordtEntries = u32(hd, 0xa8);
    const ordt2Ofs = u32(hd, 0xb0);
    const tOfs = u32(hd, 0xb4);
    if (tOfs > 0 && tOfs < head.length && ascii(head, tOfs, 4) === 'TAGX') tagxOfs = tOfs;
    if (ordtEntries > 0 && ordt2Ofs > 0 && ordt2Ofs + ordtEntries * 2 <= head.length) {
      ordt2 = new Uint16Array(ordtEntries);
      for (let i = 0; i < ordtEntries; i++) ordt2[i] = u16(hd, ordt2Ofs + i * 2);
    }
  }

  const tagx = parseTagx(head, tagxOfs);
  if (!tagx) throw new Error('dictionary index has no tag table');

  const dec = new TextDecoder(indexEncoding);
  const decode = ordt2
    ? (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(ordt2[b[i]] || b[i]); return s; }
    : (b) => dec.decode(b);
  const index = new Map();
  for (let i = 0; i < indexCount; i++) {
    const r = rec(orthIndex + 1 + i);
    if (ascii(r, 0, 4) !== 'INDX') continue;
    let rows;
    try { rows = indxEntries(r, tagx, decode); } catch (e) { continue; }
    for (const [word, tags] of rows) {
      const off = tags[1] && tags[1].length ? tags[1][0] : null;
      const len = tags[2] && tags[2].length ? tags[2][0] : null;
      if (off === null || len === null) continue;
      const k = word.toLowerCase();
      if (!index.has(k)) index.set(k, [off, len]);
    }
    if (i % 20 === 0) {
      say('Reading headword index… ' + Math.round((i / indexCount) * 100) + '%', 0.7 + 0.25 * (i / indexCount));
      await new Promise((r2) => setTimeout(r2, 0));
    }
  }

  if (!index.size) throw new Error('index parsed but held no headwords');

  say('Reading headwords from entries…', 0.9);
  const bodyDec = new TextDecoder(textEncoding);
  const derived = new Map();
  let seen = 0;
  for (const [, v] of index) {
    const lead = bodyDec.decode(text.subarray(v[0], v[0] + Math.min(300, v[1])));
    const w = headwordOf(lead);
    if (w) {
      const k = w.toLowerCase();
      if (!derived.has(k)) derived.set(k, v);
    }
    if (++seen % 15000 === 0) {
      say('Reading headwords from entries… ' + Math.round((seen / index.size) * 100) + '%', 0.9 + 0.05 * (seen / index.size));
      await new Promise((r2) => setTimeout(r2, 0));
    }
  }
  if (derived.size > 100) {
    index.clear();
    for (const [k, v] of derived) index.set(k, v);
  }

  say('Caching for offline use…', 0.97);
  await idbPut(key, {
    file: file.name,
    size: file.size,
    name: file.name.replace(/\.(mobi|prc|azw3?)$/i, ''),
    text: text.buffer,
    index: flattenIndex(index),
    encoding: textEncoding
  });

  return new MobiDictionary(file.name.replace(/\.(mobi|prc|azw3?)$/i, ''), text, index, textEncoding);
}



/* ---------- pre-parsed pack format ----------
   A .pack is the parsed dictionary — text stream plus headword index — written
   straight to disk and gzipped, so loading it skips the whole MOBI parse. */

const PACK_MAGIC = 'VDCTPK01';
const G = typeof window !== 'undefined' ? window : globalThis;

async function gzip(blob) {
  if (typeof CompressionStream === 'undefined') return blob;
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

async function gunzip(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot read gzip');
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function packDictionary(dict) {
  const enc = new TextEncoder();
  const meta = enc.encode(JSON.stringify({ name: dict.name, encoding: dict.encoding, count: dict.count }));
  const idx = enc.encode(JSON.stringify(flattenIndex(dict.index)));
  const head = new Uint8Array(16);
  for (let i = 0; i < 8; i++) head[i] = PACK_MAGIC.charCodeAt(i);
  new DataView(head.buffer).setUint32(8, meta.length, true);
  new DataView(head.buffer).setUint32(12, idx.length, true);
  return gzip(new Blob([head, meta, idx, dict.text]));
}

async function fetchBytes(url, say) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    say('Downloading dictionary… ' + Math.round(got / total * 100) + '%');
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function loadPackedDictionary(url, onProgress) {
  const say = (m) => { if (onProgress) onProgress(m); };
  const file = decodeURIComponent(String(url).split('/').pop().split('?')[0]) || 'dictionary.pack';
  say('Fetching dictionary…');
  const raw = await fetchBytes(url, say);
  const key = file + ':' + raw.length + ':v' + PARSER_VERSION;

  const cached = await idbGet(key);
  if (cached && cached.text && cached.index) {
    say('Loading cached index…');
    return new MobiDictionary(cached.name, new Uint8Array(cached.text), reviveIndex(cached.index), cached.encoding);
  }

  say('Unpacking dictionary…');
  const bytes = await gunzip(raw);
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== PACK_MAGIC) throw new Error('not a dictionary pack');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = dv.getUint32(8, true), idxLen = dv.getUint32(12, true);
  const dec = new TextDecoder();
  const meta = JSON.parse(dec.decode(bytes.subarray(16, 16 + metaLen)));
  const flat = JSON.parse(dec.decode(bytes.subarray(16 + metaLen, 16 + metaLen + idxLen)));
  const text = bytes.slice(16 + metaLen + idxLen);
  const index = reviveIndex(flat);

  say('Caching for offline use…');
  await idbPut(key, { file, size: raw.length, name: meta.name, text: text.buffer, index: flat, encoding: meta.encoding });
  return new MobiDictionary(meta.name, text, index, meta.encoding);
}

/* ---------- one dictionary, shared by every part of the app ---------- */

export function onDictionaryProgress(fn) {
  (G.__vqDictSubs = G.__vqDictSubs || []).push(fn);
  if (G.__vqDictSay) fn(G.__vqDictSay);
  return () => { G.__vqDictSubs = (G.__vqDictSubs || []).filter((f) => f !== fn); };
}

function emit(m) {
  G.__vqDictSay = m;
  (G.__vqDictSubs || []).forEach((f) => { try { f(m); } catch (e) { /* subscriber went away */ } });
}

async function firstThatExists(urls) {
  let why = '';
  for (const u of urls) {
    try {
      const h = await fetch(u, { method: 'HEAD' });
      if (h.ok) return { url: u, size: Number(h.headers.get('content-length')) || 0 };
      why = u + ' → ' + h.status;
    } catch (e) { why = u + ' → unreachable'; }
  }
  throw new Error(why || 'nothing to load');
}

// Neighbouring paths, because the reader can be mounted from a page one level
// above or below the files it ships with.
function candidates(p) {
  return /^(https?:|\/)/.test(p) ? [p] : [p, '../' + p, '/' + p];
}

async function buildDictionary(opts) {
  const keys = await cachedDictionaries();
  const current = keys.filter((k) => String(k).endsWith(':v' + PARSER_VERSION));
  if (current.length) {
    const key = String(current[0]).replace(/:v\d+$/, '');
    const cut = key.lastIndexOf(':');
    emit('Loading dictionary…');
    const d = await loadMobiDictionary(
      { name: cut > 0 ? key.slice(0, cut) : key, size: cut > 0 ? Number(key.slice(cut + 1)) || 0 : 0,
        arrayBuffer: () => Promise.reject(new Error('cache miss')) }, emit);
    emit('');
    return d;
  }
  if (keys.length) await forgetDictionaries();

  let why = '';
  if (opts.pack) {
    try {
      const hit = await firstThatExists(candidates(opts.pack));
      const d = await loadPackedDictionary(hit.url, emit);
      emit('');
      return d;
    } catch (e) { why = e.message; }
  }
  if (opts.mobi) {
    const hit = await firstThatExists(candidates(opts.mobi));
    const name = decodeURIComponent(hit.url.split('/').pop().split('?')[0]);
    const d = await loadMobiDictionary(
      { name, size: hit.size, arrayBuffer: async () => (await fetchBytes(hit.url, emit)).buffer }, emit);
    emit('');
    return d;
  }
  throw new Error(why || 'no bundled dictionary');
}

// Kicked off at desktop boot and awaited again when the reader opens; the work
// happens once and both callers get the same dictionary.
export function sharedDictionary(opts) {
  if (!G.__vqDict) {
    G.__vqDict = buildDictionary(opts || {}).catch((e) => { G.__vqDict = null; throw e; });
  }
  return G.__vqDict;
}

export function adoptDictionary(dict) { G.__vqDict = dict ? Promise.resolve(dict) : null; }

export const __test = { entryText, headwordOf, stripHtml, dedupeHead };
