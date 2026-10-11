import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, sha256File } from '../lib/sha256.js';

test('hex of empty input is the known digest', () => {
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('hex is 64 lowercase characters for arbitrary bytes', () => {
  const hex = sha256Hex(new Uint8Array([0, 1, 255]));
  assert.match(hex, /^[0-9a-f]{64}$/);
});

test('sha256Hex agrees with the digest of a known one-byte input', () => {
  assert.equal(
    sha256Hex(new Uint8Array([0x61])),
    'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
  );
});

test('sha256File hashes the file contents, not its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-sha-'));
  const path = join(dir, 'a.txt');
  await writeFile(path, 'abc');
  assert.equal(await sha256File(path), sha256Hex(new TextEncoder().encode('abc')));
});
