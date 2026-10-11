import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchBytes, readLocalFile } from '../lib/fetch.js';

function streamOf(size) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(7));
      controller.close();
    },
  });
}

test('a non-ok response is refused with its status', async () => {
  const fetchImpl = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
  await assert.rejects(fetchBytes('https://example.com/a.tgz', { fetchImpl }), /404/);
});

test('a body larger than the limit is refused', async () => {
  const fetchImpl = async () => new Response(streamOf(1000), { status: 200 });
  await assert.rejects(fetchBytes('https://example.com/a.tgz', { fetchImpl, maxBytes: 10 }), /limit/);
});

test('redirect is manual so the caller can vet every hop', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init;
    return new Response('hi', { status: 200 });
  };
  await fetchBytes('https://example.com/a.tgz', { fetchImpl });
  assert.equal(seen.redirect, 'manual');
});

test('an https redirect is followed and its bytes are returned', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/a.tgz' } });
    }
    return new Response('hi', { status: 200 });
  };
  const bytes = await fetchBytes('https://example.com/a.tgz', { fetchImpl });
  assert.equal(bytes.toString('utf8'), 'hi');
  assert.deepEqual(calls, ['https://example.com/a.tgz', 'https://cdn.example.com/a.tgz']);
});

test('a redirect to http is refused', async () => {
  const fetchImpl = async () =>
    new Response(null, { status: 302, headers: { location: 'http://evil.example/a.tgz' } });
  await assert.rejects(fetchBytes('https://example.com/a.tgz', { fetchImpl }), /https/);
});

test('readLocalFile returns bytes and enforces the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-share-fetch-'));
  const path = join(dir, 'a.tgz');
  await writeFile(path, 'abcd');
  assert.equal((await readLocalFile(path)).toString('utf8'), 'abcd');
  await assert.rejects(readLocalFile(path, { maxBytes: 2 }), /limit/);
  await assert.rejects(readLocalFile(join(dir, 'missing.tgz')), /ENOENT|no such file/i);
});

test('a first request that is not https is refused, and allowInsecure overrides it', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(Buffer.from('x'), { status: 200 });
  };
  await assert.rejects(() => fetchBytes('http://evil.example/a.tgz', { fetchImpl }), /refusing to fetch a URL that is not https/);
  assert.deepEqual(calls, []);
  assert.equal((await fetchBytes('http://127.0.0.1:1234/a.tgz', { fetchImpl, allowInsecure: true })).toString('utf8'), 'x');
  assert.deepEqual(calls, ['http://127.0.0.1:1234/a.tgz']);
});
