'use strict';
// Minimal zip writer/reader (deflate + store). No zip64. Enough for session bundles.
const zlib = require('zlib');
const fs = require('fs');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }
  add(name, data) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    let method = 8;
    let packed = zlib.deflateRawSync(raw, { level: 6 });
    if (packed.length >= raw.length) { method = 0; packed = raw; }
    const crc = crc32(raw);
    const { time, date } = dosDateTime();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10); cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36); cen.writeUInt32LE(0, 38); cen.writeUInt32LE(this.offset, 42);
    this.central.push(cen, nameBuf);
    this.parts.push(local, nameBuf, packed);
    this.offset += local.length + nameBuf.length + packed.length;
  }
  toBuffer() {
    const cenBuf = Buffer.concat(this.central);
    const n = this.central.length / 2;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cenBuf.length, 12);
    end.writeUInt32LE(this.offset, 16); end.writeUInt16LE(0, 20);
    return Buffer.concat([...this.parts, cenBuf, end]);
  }
  writeFile(path) { fs.writeFileSync(path, this.toBuffer()); }
}

class ZipReader {
  constructor(buf) {
    this.buf = buf;
    this.entries = new Map();
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const usize = buf.readUInt32LE(p + 24);
      const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
      const localOff = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nlen);
      this.entries.set(name, { method, csize, usize, localOff });
      p += 46 + nlen + elen + clen;
    }
  }
  static fromFile(path) { return new ZipReader(fs.readFileSync(path)); }
  names() { return [...this.entries.keys()]; }
  has(name) { return this.entries.has(name); }
  read(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error('No such entry: ' + name);
    const p = e.localOff;
    const nlen = this.buf.readUInt16LE(p + 26), elen = this.buf.readUInt16LE(p + 28);
    const start = p + 30 + nlen + elen;
    const data = this.buf.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error('Unsupported zip method ' + e.method);
  }
}

module.exports = { ZipWriter, ZipReader, crc32 };
