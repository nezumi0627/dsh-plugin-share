import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EMBEDDED_REQUIRED,
  REPO_REQUIRED,
  SHARE_VERSION,
  buildEmbeddedManifest,
  buildRepoManifest,
  defaultArtifactUrl,
  isValidPackageName,
  validateManifest,
} from '../lib/manifest.js';

const artifact = {
  url: 'https://github.com/nezumi0627/dsh-demo/releases/download/v1.0.0/dsh-demo-1.0.0.tgz',
  format: 'tgz',
  sha256: 'a'.repeat(64),
  bytes: 1234,
};

const repoManifest = {
  share: 1,
  name: 'dsh-demo',
  version: '1.0.0',
  summary: 'a demo plugin',
  license: 'MIT',
  author: { name: 'nezumi0627', github: 'nezumi0627', site: 'https://example.com/' },
  created: '2026-10-11T09:00:00.000Z',
  artifact,
};

test('a complete repo manifest is accepted', () => {
  const result = validateManifest(repoManifest, 'repo');
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest, repoManifest);
});

test('a short sha256 is refused and the field is named', () => {
  const result = validateManifest(
    { ...repoManifest, artifact: { ...artifact, sha256: 'abc' } },
    'repo',
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('artifact.sha256')));
});

test('an uppercase digest is refused', () => {
  const result = validateManifest(
    { ...repoManifest, artifact: { ...artifact, sha256: 'A'.repeat(64) } },
    'repo',
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('artifact.sha256')));
});

test('an artifact format other than tgz is refused', () => {
  const result = validateManifest(
    { ...repoManifest, artifact: { ...artifact, format: 'zip' } },
    'repo',
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('artifact.format')));
});

test('a created value that is not an ISO date-time is refused', () => {
  const result = validateManifest({ ...repoManifest, created: 'yesterday' }, 'repo');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('created')));
});

test('a missing author.github is refused', () => {
  const result = validateManifest({ ...repoManifest, author: { name: 'x' } }, 'repo');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('author.github')));
});

test('an embedded manifest without an artifact block is accepted', () => {
  const embedded = buildEmbeddedManifest({
    name: 'dsh-demo',
    version: '1.0.0',
    author: { github: 'nezumi0627' },
    created: '2026-10-11T09:00:00.000Z',
  });
  const result = validateManifest(embedded, 'embedded');
  assert.equal(result.ok, true);
  assert.equal('artifact' in result.manifest, false);
});

test('an embedded manifest carrying an artifact block is refused', () => {
  const embedded = { ...buildEmbeddedManifest({
    name: 'dsh-demo',
    version: '1.0.0',
    author: { github: 'nezumi0627' },
    created: '2026-10-11T09:00:00.000Z',
  }), artifact };
  const result = validateManifest(embedded, 'embedded');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('artifact')));
});

test('buildRepoManifest sets share to the supported version and the tgz format', () => {
  const manifest = buildRepoManifest({
    name: 'dsh-demo',
    version: '1.0.0',
    author: { github: 'nezumi0627' },
    created: '2026-10-11T09:00:00.000Z',
    artifact: { sha256: 'b'.repeat(64), bytes: 5 },
  });
  assert.equal(manifest.share, SHARE_VERSION);
  assert.equal(manifest.artifact.format, 'tgz');
  assert.equal(manifest.artifact.sha256, 'b'.repeat(64));
  assert.equal('url' in manifest.artifact, false);
});

test('defaultArtifactUrl names the release asset exactly', () => {
  assert.equal(
    defaultArtifactUrl({ owner: 'nezumi0627', repo: 'dsh-demo', tag: 'v1.0.0', name: 'dsh-demo', version: '1.0.0' }),
    'https://github.com/nezumi0627/dsh-demo/releases/download/v1.0.0/dsh-demo-1.0.0.tgz',
  );
});

test('isValidPackageName accepts plain and scoped names and refuses the rest', () => {
  assert.equal(isValidPackageName('dsh-demo'), true);
  assert.equal(isValidPackageName('@local/dsh-locale-ja'), true);
  assert.equal(isValidPackageName('Dsh-Demo'), false);
  assert.equal(isValidPackageName('dsh demo'), false);
  assert.equal(isValidPackageName('-leading'), false);
  assert.equal(isValidPackageName('a'.repeat(215)), false);
});

test('the JSON Schema lists the same required keys as the validator', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../schema/plugin-share.schema.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual([...schema.$defs.repo.required].sort(), [...REPO_REQUIRED].sort());
  assert.deepEqual([...schema.$defs.embedded.required].sort(), [...EMBEDDED_REQUIRED].sort());
});
