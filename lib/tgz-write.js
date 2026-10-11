/**
 * Minimal npm-format tarball writer.
 *
 * The plugin-share artifact is an ordinary `npm pack` tarball: every entry lives
 * under `package/`, so pnpm can install it and resolve the dependencies it
 * declares. Writing it here instead of shelling out to `npm pack` keeps the
 * author's lifecycle scripts out of the pack (spec §7.2) and keeps this plugin
 * dependency-free.
 *
 * @module dsh-plugin-share/tgz-write
 */
import { gzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const CHECKSUM_OFFSET = 148;
const MAGIC_OFFSET = 257;
const PREFIX_OFFSET = 345;

/** Octal field: digits plus a terminating NUL, right-aligned in `length`. */
function octal(value, length) {
  const text = Math.trunc(value).toString(8);
  if (text.length > length - 1) {
    throw new Error(`tar: value ${value} does not fit in ${length} octal digits`);
  }
  return text.padStart(length - 1, '0') + '\0';
}

/** Split a long name across the `prefix` and `name` fields, as ustar expects. */
function splitName(name) {
  if (Buffer.byteLength(name, 'utf8') <= NAME_MAX) return { base: name, prefix: '' };
  let index = name.length;
  while ((index = name.lastIndexOf('/', index - 1)) > 0) {
    const prefix = name.slice(0, index);
    const base = name.slice(index + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= PREFIX_MAX && Buffer.byteLength(base, 'utf8') <= NAME_MAX) {
      return { base, prefix };
    }
  }
  throw new Error(`tar: entry name is too long: ${name}`);
}

function toBuffer(data, name) {
  if (data === undefined || data === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error(`tar: entry data must be bytes: ${name}`);
}

function buildHeader({ name, size, mode, mtimeMs, typeflag }) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { base, prefix } = splitName(name);
  header.write(base, 0, NAME_MAX, 'utf8');
  header.write(octal(mode, 8), 100, 8, 'utf8');
  header.write(octal(0, 8), 108, 8, 'utf8');
  header.write(octal(0, 8), 116, 8, 'utf8');
  header.write(octal(size, 12), 124, 12, 'utf8');
  header.write(octal(Math.floor(mtimeMs / 1000), 12), 136, 12, 'utf8');
  header.write('        ', CHECKSUM_OFFSET, 8, 'utf8');
  header.write(typeflag, 156, 1, 'utf8');
  header.write('ustar\0', MAGIC_OFFSET, 6, 'latin1');
  header.write('00', 263, 2, 'utf8');
  header.write(prefix, PREFIX_OFFSET, PREFIX_MAX, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', CHECKSUM_OFFSET, 8, 'utf8');
  return header;
}

/**
 * Build an npm-format tarball.
 *
 * @param {Array<{name: string, data?: Uint8Array, mode?: number}>} entries
 *   Entry names are posix paths that must start with `package/`. A name ending
 *   in `/` is written as a directory entry and carries no data.
 * @param {{mtimeMs?: number, gzipLevel?: number}} [opts]
 *   `mtimeMs` is written into every header, so a fixed value makes the output
 *   byte-identical across runs.
 * @returns {Buffer} the gzipped tarball
 */
export function writeTarball(entries, opts = {}) {
  const mtimeMs = opts.mtimeMs ?? Date.now();
  const gzipLevel = opts.gzipLevel ?? 9;
  const parts = [];
  for (const entry of entries) {
    const name = entry?.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('tar: every entry needs a name');
    }
    if (!name.startsWith('package/')) {
      throw new Error(`tar: entry name must start with "package/": ${name}`);
    }
    const isDirectory = name.endsWith('/');
    const data = isDirectory ? Buffer.alloc(0) : toBuffer(entry.data, name);
    parts.push(
      buildHeader({
        name,
        size: data.length,
        mode: entry.mode ?? (isDirectory ? 0o755 : 0o644),
        mtimeMs,
        typeflag: isDirectory ? '5' : '0',
      }),
    );
    if (!isDirectory) {
      parts.push(data);
      const remainder = data.length % BLOCK_SIZE;
      if (remainder !== 0) parts.push(Buffer.alloc(BLOCK_SIZE - remainder));
    }
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(parts), { level: gzipLevel });
}
