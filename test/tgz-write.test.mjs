import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { writeTarball } from '../lib/tgz-write.js';

const entries = [
  { name: 'package/package.json', data: Buffer.from('{"name":"x"}') },
  { name: 'package/lib/a.js', data: Buffer.from('export const a = 1;') },
];

test('output is gzip whose payload starts with a 512-byte tar header naming the entry', () => {
  const tar = gunzipSync(writeTarball(entries, { mtimeMs: 0 }));
  const header = tar.subarray(0, 512).toString('utf8');
  assert.match(header.slice(0, 100), /^package\/package\.json\0/);
  assert.equal(header.slice(257, 262), 'ustar');
});

test('payload is padded to 512-byte blocks and ends with two zero blocks', () => {
  const tar = gunzipSync(writeTarball(entries, { mtimeMs: 0 }));
  assert.equal(tar.length % 512, 0);
  assert.deepEqual([...tar.subarray(tar.length - 1024)], new Array(1024).fill(0));
});

test('the same entries and mtime produce identical bytes', () => {
  const a = writeTarball(entries, { mtimeMs: 0 });
  const b = writeTarball(entries, { mtimeMs: 0 });
  assert.deepEqual(a, b);
});

test('a name outside package/ is refused', () => {
  assert.throws(() => writeTarball([{ name: 'evil.js', data: new Uint8Array(0) }]), /package\//);
});
