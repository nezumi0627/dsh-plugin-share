/**
 * Minimal npm-format tarball reader with the safety rules this plugin relies on.
 *
 * plugin-share never extracts a tarball: pnpm does that after the profile accepts
 * the verified file. This reader only has to answer two questions safely — "what
 * does the package declare?" and "is this archive shaped like something we are
 * willing to hand to pnpm?" — so it refuses absolute names, `..` segments, link
 * entries, and archives that exceed the size and entry caps.
 *
 * @module dsh-plugin-share/tgz-read
 */
import { gunzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

/** Caps applied when the caller names none. */
export const DEFAULT_LIMITS = {
  maxEntries: 5000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressedBytes: 128 * 1024 * 1024,
};

function readString(field) {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function readName(header) {
  const base = readString(header.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH));
  const prefix = readString(header.subarray(PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_LENGTH));
  return prefix === '' ? base : `${prefix}/${base}`;
}

/** A tar numeric field is octal text, or base-256 when its top bit is set. */
function readNumber(field, name) {
  if ((field[0] & 0x80) !== 0) {
    let value = field[0] & 0x7f;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index];
    return value;
  }
  const text = field.toString('latin1').replace(/\0/g, ' ').trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`tar: unreadable numeric field for ${name}`);
  return value;
}

function assertSafeName(name) {
  if (name.includes('\0')) throw new Error('tar: entry name contains a NUL byte');
  if (name === '' || name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new Error(`tar: absolute path in entry name: ${name}`);
  }
  if (name.split('/').includes('..')) {
    throw new Error(`tar: entry name escapes the archive: ${name}`);
  }
}

function refuseLink(typeflag, name) {
  if (typeflag === '1') throw new Error(`tar: hard link entries are not allowed: ${name}`);
  if (typeflag === '2') throw new Error(`tar: symbolic link entries are not allowed: ${name}`);
  throw new Error(`tar: unsupported entry type ${JSON.stringify(typeflag)}: ${name}`);
}

/**
 * Read a gzipped tarball into its regular-file entries, refusing anything unsafe.
 *
 * @param {Uint8Array} bytes the gzipped tarball
 * @param {Partial<typeof DEFAULT_LIMITS>} [opts]
 * @returns {Array<{name: string, data: Buffer}>} regular files; directory entries are skipped
 */
export function readTarball(bytes, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...opts };
  if (bytes.length > limits.maxCompressedBytes) {
    throw new Error(
      `tar: compressed input is larger than the limit (${bytes.length} > ${limits.maxCompressedBytes})`,
    );
  }
  const tar = gunzipSync(bytes);
  const entries = [];
  let total = 0;
  let offset = 0;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) break;
    const name = readName(header);
    const size = readNumber(header.subarray(SIZE_OFFSET, SIZE_OFFSET + SIZE_LENGTH), name);
    const typeflag = header[TYPEFLAG_OFFSET] === 0 ? '0' : String.fromCharCode(header[TYPEFLAG_OFFSET]);
    const body = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (typeflag === '5') {
      offset += body;
      continue;
    }
    if (typeflag !== '0') refuseLink(typeflag, name);
    assertSafeName(name);
    if (entries.length + 1 > limits.maxEntries) {
      throw new Error(`tar: too many entries (more than ${limits.maxEntries})`);
    }
    if (size > limits.maxEntryBytes) {
      throw new Error(`tar: entry ${name} is larger than the limit (${size} > ${limits.maxEntryBytes})`);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new Error(`tar: total extracted size is larger than the limit (${total} > ${limits.maxTotalBytes})`);
    }
    const data = tar.subarray(offset, offset + size);
    if (data.length !== size) throw new Error(`tar: truncated entry: ${name}`);
    entries.push({ name, data: Buffer.from(data) });
    offset += body;
  }
  return entries;
}

/**
 * Read one entry by exact name.
 *
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {Partial<typeof DEFAULT_LIMITS>} [opts]
 * @returns {Buffer | undefined}
 */
export function readEntry(bytes, name, opts = {}) {
  return readTarball(bytes, opts).find((entry) => entry.name === name)?.data;
}
