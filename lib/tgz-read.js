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
  // An npm tarball carries posix paths, so a backslash is either a broken archive
  // or an attempt to slip a traversal past the `/`-only walk below — where Windows
  // would read it as a separator.
  if (name.includes('\\')) {
    throw new Error(`tar: entry name contains a backslash: ${name}`);
  }
  if (name.split('/').includes('..')) {
    throw new Error(`tar: entry name escapes the archive: ${name}`);
  }
}

/**
 * Inflate the archive, refusing to allocate more than the caps allow.
 *
 * The declared entry sizes only bound the *result* of inflating, and gzip expands
 * roughly 1000:1, so the inflate itself has to be bounded: without a ceiling a
 * 1 MB input can ask for gigabytes before a single cap is compared.
 *
 * @param {Uint8Array} bytes
 * @param {typeof DEFAULT_LIMITS} limits
 * @returns {Buffer}
 */
function inflate(bytes, limits) {
  const ceiling = limits.maxTotalBytes + limits.maxEntries * 2 * BLOCK_SIZE + 1024 * 1024;
  try {
    return gunzipSync(bytes, { maxOutputLength: ceiling });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/larger than|ERR_BUFFER_TOO_LARGE|maxOutputLength/i.test(message)) {
      throw new Error(`tar: the archive expands beyond the limit (${ceiling} bytes)`);
    }
    throw new Error(`tar: not a readable gzip archive (${message})`);
  }
}

/** Parsed entries per input object, with the limits they were parsed under. */
const parsedByInput = new WeakMap();

function sameLimits(a, b) {
  return (
    a.maxEntries === b.maxEntries &&
    a.maxEntryBytes === b.maxEntryBytes &&
    a.maxTotalBytes === b.maxTotalBytes &&
    a.maxCompressedBytes === b.maxCompressedBytes
  );
}

function refuseLink(typeflag, name) {
  if (typeflag === '1') throw new Error(`tar: hard link entries are not allowed: ${name}`);
  if (typeflag === '2') throw new Error(`tar: symbolic link entries are not allowed: ${name}`);
  throw new Error(`tar: unsupported entry type ${JSON.stringify(typeflag)}: ${name}`);
}

/**
 * Read a gzipped tarball into its regular-file entries, refusing anything unsafe.
 *
 * A caller that reads several entries out of one archive — the install path reads
 * four — gets the parse done once, because inflating a 48 MB archive six times is
 * a denial of service all by itself. The result is keyed by the exact input object
 * and the limits, and callers must not mutate bytes they hand in.
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
  const cached = parsedByInput.get(bytes);
  if (cached !== undefined && sameLimits(cached.limits, limits)) return cached.entries;

  const tar = inflate(bytes, limits);
  const entries = [];
  const seen = new Set();
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
    // Every entry is name-checked, directory entries included: a directory names a
    // path as much as a file does, and this reader is the only shape check between
    // untrusted bytes and the profile's package manager.
    assertSafeName(name);
    if (typeflag === '5') {
      offset += body;
      continue;
    }
    if (typeflag !== '0') refuseLink(typeflag, name);
    // Two entries with one name let a reader verify the first while an extractor
    // writes the last, so the archive is refused rather than described.
    if (seen.has(name)) {
      throw new Error(`tar: duplicate entry name: ${name}`);
    }
    seen.add(name);
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
  parsedByInput.set(bytes, { limits, entries });
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
