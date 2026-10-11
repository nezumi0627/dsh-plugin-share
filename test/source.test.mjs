import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, manifestUrlFor, artifactUrlFor } from '../lib/source.js';

test('a bare GitHub repository URL parses with no ref', () => {
  assert.deepEqual(parseSource('https://github.com/nezumi0627/dsh-demo'), {
    kind: 'repo',
    owner: 'nezumi0627',
    repo: 'dsh-demo',
    ref: undefined,
    htmlUrl: 'https://github.com/nezumi0627/dsh-demo',
  });
});

test('a .git suffix is tolerated', () => {
  assert.equal(parseSource('https://github.com/o/r.git').repo, 'r');
});

test('a tree URL carries its ref', () => {
  const source = parseSource('https://github.com/o/r/tree/v1.0.0');
  assert.equal(source.kind, 'repo');
  assert.equal(source.ref, 'v1.0.0');
  assert.equal(source.htmlUrl, 'https://github.com/o/r/tree/v1.0.0');
});

test('a release tag URL is its own kind', () => {
  assert.deepEqual(parseSource('https://github.com/o/r/releases/tag/v1.0.0'), {
    kind: 'release',
    owner: 'o',
    repo: 'r',
    tag: 'v1.0.0',
    htmlUrl: 'https://github.com/o/r/releases/tag/v1.0.0',
  });
});

test('an https tarball URL is accepted whatever the host', () => {
  const source = parseSource('https://example.com/a/dsh-demo-1.0.0.tgz');
  assert.equal(source.kind, 'tarball-url');
  assert.equal(source.filename, 'dsh-demo-1.0.0.tgz');
});

test('an https URL that is neither a repository nor a tarball is refused', () => {
  assert.throws(() => parseSource('https://example.com/a/page.html'), /repository or a tarball/);
});

test('a Windows absolute path to a tarball is a local tarball', () => {
  const source = parseSource('C:\\tmp\\dsh-demo-1.0.0.tgz');
  assert.equal(source.kind, 'local-tarball');
  assert.equal(source.path, 'C:\\tmp\\dsh-demo-1.0.0.tgz');
});

test('a Windows absolute path to a directory is a local directory', () => {
  const source = parseSource('C:\\tmp\\dsh-demo');
  assert.equal(source.kind, 'local-dir');
  assert.equal(source.path, 'C:\\tmp\\dsh-demo');
});

test('http is refused unless the caller allows it', () => {
  assert.throws(() => parseSource('http://github.com/o/r'), /https/);
  assert.equal(parseSource('http://example.com/a.tgz', { allowInsecure: true }).kind, 'tarball-url');
});

test('a relative path is refused', () => {
  assert.throws(() => parseSource('./relative'), /absolute/);
});

test('an empty source is refused', () => {
  assert.throws(() => parseSource('   '), /empty/);
});

test('manifestUrlFor points at raw.githubusercontent for repository sources', () => {
  assert.equal(
    manifestUrlFor(parseSource('https://github.com/o/r')),
    'https://raw.githubusercontent.com/o/r/HEAD/plugin-share.json',
  );
  assert.equal(
    manifestUrlFor(parseSource('https://github.com/o/r/tree/v1.0.0')),
    'https://raw.githubusercontent.com/o/r/v1.0.0/plugin-share.json',
  );
  assert.equal(
    manifestUrlFor(parseSource('https://github.com/o/r/releases/tag/v1.0.0')),
    'https://raw.githubusercontent.com/o/r/v1.0.0/plugin-share.json',
  );
  assert.equal(manifestUrlFor(parseSource('https://example.com/a.tgz')), undefined);
});

test('artifactUrlFor derives the release asset, and passes a direct URL through', () => {
  assert.equal(
    artifactUrlFor(parseSource('https://github.com/o/r'), 'dsh-demo', '1.0.0'),
    'https://github.com/o/r/releases/download/v1.0.0/dsh-demo-1.0.0.tgz',
  );
  assert.equal(
    artifactUrlFor(parseSource('https://github.com/o/r/releases/tag/v2.0.0'), 'dsh-demo', '2.0.0'),
    'https://github.com/o/r/releases/download/v2.0.0/dsh-demo-2.0.0.tgz',
  );
  assert.equal(
    artifactUrlFor(parseSource('https://example.com/a/dsh-demo-1.0.0.tgz'), 'dsh-demo', '1.0.0'),
    'https://example.com/a/dsh-demo-1.0.0.tgz',
  );
  assert.equal(
    artifactUrlFor(parseSource('C:\\tmp\\dsh-demo-1.0.0.tgz'), 'dsh-demo', '1.0.0'),
    'C:\\tmp\\dsh-demo-1.0.0.tgz',
  );
});
