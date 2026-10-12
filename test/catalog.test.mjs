import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogReleaseTag, mergeCatalogReadme, renderCatalog, upsertCatalogEntry, validateCatalog } from '../lib/catalog.js';

test('release tags include a normalized package identity and version', () => {
  assert.match(catalogReleaseTag('demo', '1.2.0'), /^demo-[a-f0-9]{10}-v1\.2\.0$/);
  assert.match(catalogReleaseTag('@local/demo', '1.2.0'), /^local-demo-[a-f0-9]{10}-v1\.2\.0$/);
  assert.notEqual(catalogReleaseTag('@local/one', '1.0.0'), catalogReleaseTag('@local/two', '1.0.0'));
});

test('catalog markdown sorts packages and links each entry to its release', () => {
  const output = renderCatalog([
    { name: 'zeta', version: '1.0.0', summary: 'Z plugin', releaseUrl: 'https://github.com/o/r/releases/tag/zeta-v1.0.0' },
    { name: 'alpha', version: '2.0.0', summary: 'A plugin', releaseUrl: 'https://github.com/o/r/releases/tag/alpha-v2.0.0' },
  ]);
  assert.ok(output.indexOf('releases/tag/alpha-v2.0.0') < output.indexOf('releases/tag/zeta-v1.0.0'));
});

test('catalog upsert preserves other entries and replaces the same plugin', () => {
  const oldEntry = { name: 'alpha', version: '1.0.0', summary: 'old', tag: 'alpha-v1.0.0', releaseUrl: 'https://github.com/o/r/releases/tag/a', artifactUrl: 'https://github.com/o/r/releases/download/a/a.tgz', sha256: 'a'.repeat(64), bytes: 3 };
  const other = { ...oldEntry, name: 'beta' };
  const updated = { ...oldEntry, version: '1.1.0', summary: 'new' };
  const result = upsertCatalogEntry({ version: 1, plugins: [oldEntry, other] }, updated);
  assert.deepEqual(result.plugins.map((entry) => entry.name), ['alpha', 'beta']);
  assert.equal(result.plugins[0].version, '1.1.0');
  assert.equal(result.plugins[1].version, '1.0.0');
});

test('catalog README update preserves surrounding user content and refuses broken markers', () => {
  const readme = mergeCatalogReadme('# Notes\n', []);
  assert.match(readme, /^# Notes/);
  assert.equal(mergeCatalogReadme(readme, []).match(/DSH_PLUGIN_CATALOG:START/g).length, 1);
  assert.throws(() => mergeCatalogReadme('<!-- DSH_PLUGIN_CATALOG:START -->', []), /markers are invalid/);
});

test('catalog rejects duplicate plugin names and non-GitHub asset links', () => {
  const entry = { name: 'demo', version: '1.0.0', summary: '', tag: 'demo-v1.0.0', releaseUrl: 'https://github.com/o/r/releases/tag/demo-v1.0.0', artifactUrl: 'https://github.com/o/r/releases/download/demo-v1.0.0/demo.tgz', sha256: 'a'.repeat(64), bytes: 4 };
  assert.throws(() => validateCatalog({ version: 1, plugins: [entry, entry] }), /duplicate plugins/);
  assert.throws(() => validateCatalog({ version: 1, plugins: [{ ...entry, artifactUrl: 'https://example.com/demo.tgz' }] }), /non-GitHub URL/);
  assert.throws(() => upsertCatalogEntry({ version: 1, plugins: [] }, { ...entry, sha256: 'bad' }), /invalid entry/);
});
