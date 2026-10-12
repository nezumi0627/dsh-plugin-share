import { createHash } from 'node:crypto';
import { isValidPackageName, isValidVersion } from './manifest.js';

function cleanCell(value) {
  return String(value ?? '').replace(/[|\r\n\[\]]/g, ' ').trim();
}

export function catalogReleaseTag(name, version) {
  if (!isValidPackageName(name) || !isValidVersion(version)) throw new Error('A valid package name and version are required to name a catalog release.');
  const slug = name.replace(/^@/, '').replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'plugin';
  const identity = createHash('sha256').update(name).digest('hex').slice(0, 10);
  return `${slug}-${identity}-v${version}`;
}

export function validateCatalog(value) {
  if (value === null || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.plugins)) {
    throw new Error('The shared repository catalog is invalid; no changes were published.');
  }
  const names = new Set();
  for (const entry of value.plugins) {
    if (entry === null || typeof entry !== 'object' || !isValidPackageName(entry.name) || !isValidVersion(entry.version) ||
        typeof entry.summary !== 'string' || typeof entry.tag !== 'string' || typeof entry.releaseUrl !== 'string' ||
        typeof entry.artifactUrl !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('The shared repository catalog contains an invalid entry; no changes were published.');
    }
    if (names.has(entry.name)) throw new Error('The shared repository catalog contains duplicate plugins; no changes were published.');
    names.add(entry.name);
    for (const value of [entry.releaseUrl, entry.artifactUrl]) {
      let url;
      try { url = new URL(value); } catch { throw new Error('The shared repository catalog contains an invalid URL; no changes were published.'); }
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username !== '' || url.password !== '') throw new Error('The shared repository catalog contains a non-GitHub URL; no changes were published.');
    }
  }
  return value.plugins;
}

export function upsertCatalogEntry(catalog, entry) {
  const plugins = validateCatalog(catalog);
  validateCatalog({ version: 1, plugins: [entry] });
  const next = plugins.filter((item) => item.name !== entry.name);
  next.push(entry);
  next.sort((left, right) => left.name.localeCompare(right.name));
  return { version: 1, plugins: next };
}

export function renderCatalog(plugins) {
  const rows = [...plugins].sort((left, right) => left.name.localeCompare(right.name));
  const lines = [
    '# DSH Plugin Catalog',
    '',
    'Plugins shared from this repository. Open a release to download its verified package.',
    '',
    '| Plugin | Version | Description | Release |',
    '| --- | --- | --- | --- |',
  ];
  for (const plugin of rows) {
    const release = new URL(plugin.releaseUrl);
    if (release.protocol !== 'https:' || release.hostname !== 'github.com') throw new Error('Catalog release links must use github.com over HTTPS.');
    lines.push(`| ${cleanCell(plugin.name)} | ${cleanCell(plugin.version)} | ${cleanCell(plugin.summary)} | [Download](${release.href}) |`);
  }
  return `${lines.join('\n')}\n`;
}

const START = '<!-- DSH_PLUGIN_CATALOG:START -->';
const END = '<!-- DSH_PLUGIN_CATALOG:END -->';

export function mergeCatalogReadme(existing, plugins) {
  const section = `${START}\n${renderCatalog(plugins).trimEnd()}\n${END}`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start !== -1 || end !== -1) {
    if (start === -1 || end < start) throw new Error('The catalog README markers are invalid; no changes were published.');
    return `${existing.slice(0, start)}${section}${existing.slice(end + END.length)}`;
  }
  return `${existing.trimEnd()}${existing.trim() === '' ? '' : '\n\n'}${section}\n`;
}
