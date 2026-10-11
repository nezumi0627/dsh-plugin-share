/**
 * The plugin-share store, under `$DSH_HOME/plugin-share/`.
 *
 * Two things live here: the verified artifacts, kept so a later `verify` can
 * re-hash the exact bytes that were installed, and the install ledger, which
 * records where each one came from. Nothing else in DSH is touched.
 *
 * @module dsh-plugin-share/store
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from './sha256.js';

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const LEDGER_NAME = 'installed.json';

/**
 * The store's root directory.
 *
 * @param {{root?: string}} [opts]
 * @returns {string}
 */
export function storeRoot(opts = {}) {
  return opts.root ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-share');
}

/** One flat directory name per package, so a scope cannot become a nested path. */
function directoryName(name) {
  const flattened = String(name).replace(/^@/, '').replace(/\//g, '-');
  if (flattened === '' || /[\\/]/.test(flattened) || flattened.includes('..')) {
    throw new Error(`store: refusing a package name that is not a single path segment: ${name}`);
  }
  return flattened;
}

function assertVersion(version) {
  if (typeof version !== 'string' || !SAFE_VERSION.test(version)) {
    throw new Error(`store: refusing a version that is not a single path segment: ${version}`);
  }
  return version;
}

/**
 * Where a version's artifact lives.
 *
 * @param {string} name
 * @param {string} version
 * @param {{root?: string}} [opts]
 * @returns {string}
 */
export function artifactPath(name, version, opts = {}) {
  return join(storeRoot(opts), 'artifacts', directoryName(name), `${assertVersion(version)}.tgz`);
}

/**
 * Write an artifact, replacing any earlier copy of the same version.
 *
 * @param {string} name
 * @param {string} version
 * @param {Uint8Array} bytes
 * @param {{root?: string}} [opts]
 * @returns {Promise<string>} the path written
 */
export async function storeArtifact(name, version, bytes, opts = {}) {
  const path = artifactPath(name, version, opts);
  await mkdir(join(storeRoot(opts), 'artifacts', directoryName(name)), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return path;
}

/**
 * Read a stored artifact.
 *
 * @param {string} name
 * @param {string} version
 * @param {{root?: string}} [opts]
 * @returns {Promise<Buffer | undefined>} undefined when it was never stored
 */
export async function readArtifact(name, version, opts = {}) {
  try {
    return await readFile(artifactPath(name, version, opts));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Re-hash a stored artifact and compare it with the expected digest.
 *
 * @param {string} name
 * @param {string} version
 * @param {string} expected the 64-character lowercase hex digest to match
 * @param {{root?: string}} [opts]
 * @returns {Promise<{ok: true, path: string} | {ok: false, reason: 'missing'} |
 *   {ok: false, reason: 'mismatch', actual: string, path: string}>}
 */
export async function verifyArtifact(name, version, expected, opts = {}) {
  const path = artifactPath(name, version, opts);
  let actual;
  try {
    actual = await sha256File(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, reason: 'missing' };
    throw error;
  }
  return actual === expected ? { ok: true, path } : { ok: false, reason: 'mismatch', actual, path };
}

async function writeLedger(records, opts) {
  const root = storeRoot(opts);
  await mkdir(root, { recursive: true });
  const path = join(root, LEDGER_NAME);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`);
  await rename(temporary, path);
}

/**
 * Every install this plugin has recorded, sorted by name.
 *
 * @param {{root?: string}} [opts]
 * @returns {Promise<object[]>} empty when the ledger is missing or unreadable
 */
export async function readInstalled(opts = {}) {
  try {
    const parsed = JSON.parse(await readFile(join(storeRoot(opts), LEDGER_NAME), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return [...parsed].sort((left, right) => String(left?.name).localeCompare(String(right?.name)));
  } catch {
    return [];
  }
}

/**
 * One install record by package name.
 *
 * @param {string} name
 * @param {{root?: string}} [opts]
 * @returns {Promise<object | undefined>}
 */
export async function findInstalled(name, opts = {}) {
  const records = await readInstalled(opts);
  return records.find((record) => record.name === name);
}

/**
 * Record an install, replacing any earlier record for the same package name.
 *
 * @param {{name: string, version: string, sha256: string, installedAt: string,
 *   source: string, profileSpec: string, format: 'tgz'}} record
 * @param {{root?: string}} [opts]
 * @returns {Promise<object[]>} the ledger as written
 */
export async function recordInstall(record, opts = {}) {
  const records = (await readInstalled(opts)).filter((entry) => entry.name !== record.name);
  records.push(record);
  const sorted = [...records].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  await writeLedger(sorted, opts);
  return sorted;
}

/**
 * Forget one package's install record. The stored artifact is left alone.
 *
 * @param {string} name
 * @param {{root?: string}} [opts]
 * @returns {Promise<boolean>} whether a record was there to remove
 */
export async function removeInstalled(name, opts = {}) {
  const records = await readInstalled(opts);
  const kept = records.filter((record) => record.name !== name);
  if (kept.length === records.length) return false;
  await writeLedger(kept, opts);
  return true;
}

/**
 * Delete the whole store. Used by tests and by anyone starting over.
 *
 * @param {{root?: string}} [opts]
 * @returns {Promise<void>}
 */
export async function clearStore(opts = {}) {
  await rm(storeRoot(opts), { recursive: true, force: true });
}
