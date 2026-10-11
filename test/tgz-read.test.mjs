import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { writeTarball } from '../lib/tgz-write.js';
import { readTarball, readEntry } from '../lib/tgz-read.js';

const BLOCK = 512;

/** Build one ustar header by hand, so a test can forge the hostile cases. */
function tarHeader({ name, size = 0, typeflag = '0' }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write(typeflag, 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return header;
}

function rawTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const typeflag = entry.typeflag ?? '0';
    const data = typeflag === '0' ? Buffer.from(entry.data ?? '') : Buffer.alloc(0);
    parts.push(tarHeader({ name: entry.name, size: data.length, typeflag }));
    if (data.length > 0) {
      parts.push(data);
      const remainder = data.length % BLOCK;
      if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

test('round-trips the entries writeTarball wrote', () => {
  const bytes = writeTarball(
    [
      { name: 'package/package.json', data: Buffer.from('{"name":"x"}') },
      { name: 'package/lib/', data: Buffer.alloc(0) },
      { name: 'package/lib/a.js', data: Buffer.from('export const a = 1;') },
    ],
    { mtimeMs: 0 },
  );
  const entries = readTarball(bytes);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['package/package.json', 'package/lib/a.js'],
  );
  assert.equal(entries[0].data.toString('utf8'), '{"name":"x"}');
  assert.equal(entries[1].data.toString('utf8'), 'export const a = 1;');
});

test('an absolute entry name is refused', () => {
  assert.throws(() => readTarball(rawTar([{ name: '/etc/passwd', data: 'x' }])), /absolute path/);
});

test('a name that escapes the archive is refused', () => {
  assert.throws(
    () => readTarball(rawTar([{ name: 'package/../../evil', data: 'x' }])),
    /escapes/,
  );
});

test('a symbolic link entry is refused', () => {
  assert.throws(
    () => readTarball(rawTar([{ name: 'package/link', typeflag: '2' }])),
    /symbolic link/,
  );
});

test('more entries than the limit are refused', () => {
  const bytes = rawTar([
    { name: 'package/a', data: 'a' },
    { name: 'package/b', data: 'b' },
  ]);
  assert.throws(() => readTarball(bytes, { maxEntries: 1 }), /too many entries/);
});

test('compressed input over the limit is refused', () => {
  const bytes = rawTar([{ name: 'package/a', data: 'a'.repeat(4096) }]);
  assert.throws(() => readTarball(bytes, { maxCompressedBytes: 10 }), /compressed/);
});

test('an entry over the per-entry limit is refused', () => {
  const bytes = rawTar([{ name: 'package/a', data: 'abcd' }]);
  assert.throws(() => readTarball(bytes, { maxEntryBytes: 3 }), /entry/);
});

test('total extracted size over the limit is refused', () => {
  const bytes = rawTar([
    { name: 'package/a', data: 'aa' },
    { name: 'package/b', data: 'bb' },
  ]);
  assert.throws(() => readTarball(bytes, { maxTotalBytes: 3 }), /total/);
});

test('readEntry returns one entry by name and undefined for a missing name', () => {
  const bytes = writeTarball([{ name: 'package/a.js', data: Buffer.from('hi') }], { mtimeMs: 0 });
  assert.equal(readEntry(bytes, 'package/a.js').toString('utf8'), 'hi');
  assert.equal(readEntry(bytes, 'package/missing.js'), undefined);
});
