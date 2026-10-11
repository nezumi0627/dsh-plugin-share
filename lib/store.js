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

/** The ledger's own format version, so a later build can migrate it. */
export const LEDGER_VERSION = 1;

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

async function writeLedger(installs, opts) {
  const root = storeRoot(opts);
  await mkdir(root, { recursive: true });
  const path = join(root, LEDGER_NAME);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ share: LEDGER_VERSION, installs }, null, 2)}\n`);
  await rename(temporary, path);
}

async function readLedger(opts) {
  try {
    const parsed = JSON.parse(await readFile(join(storeRoot(opts), LEDGER_NAME), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.installs)) {
      return { share: LEDGER_VERSION, installs: [] };
    }
    return {
      share: LEDGER_VERSION,
      installs: parsed.installs.filter((record) => record !== null && typeof record === 'object'),
    };
  } catch {
    return { share: LEDGER_VERSION, installs: [] };
  }
}

/**
 * Every install this plugin has recorded, oldest first, superseded rows included.
 *
 * @param {{root?: string}} [opts]
 * @returns {Promise<object[]>} empty when the ledger is missing or unreadable
 */
export async function readInstalled(opts = {}) {
  return (await readLedger(opts)).installs;
}

/**
 * One record per package name: the latest one that is not superseded.
 *
 * @param {{root?: string}} [opts]
 * @returns {Promise<object[]>} sorted by name
 */
export async function currentInstalls(opts = {}) {
  const installs = await readInstalled(opts);
  const latest = new Map();
  for (const record of installs) {
    if (record.state === 'superseded') continue;
    latest.set(record.name, record);
  }
  return [...latest.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

/**
 * The current install record of one package.
 *
 * @param {string} name
 * @param {{root?: string}} [opts]
 * @returns {Promise<object | undefined>}
 */
export async function findInstalled(name, opts = {}) {
  return (await currentInstalls(opts)).find((record) => record.name === name);
}

/**
 * Record an install.
 *
 * A new version supersedes every earlier record of the same name, which stays in
 * the file as history. Finishing a `pending-builds` attempt replaces that row
 * instead of adding a second live one.
 *
 * @param {{name: string, version: string, source: object, artifact: object,
 *   installedAt: string, profileSpec: string, state: string}} record
 * @param {{root?: string}} [opts]
 * @returns {Promise<object[]>} the ledger as written
 */
export async function recordInstall(record, opts = {}) {
  const installs = await readInstalled(opts);
  const last = [...installs].reverse().find((entry) => entry.name === record.name);
  const resumesPending = last !== undefined && last.state === 'pending-builds' && record.state === 'installed';
  let kept;
  if (resumesPending) {
    kept = [...installs];
    kept[installs.lastIndexOf(last)] = record;
  } else {
    kept = installs.map((entry) => (entry.name === record.name ? { ...entry, state: 'superseded' } : entry));
    kept.push(record);
  }
  await writeLedger(kept, opts);
  return kept;
}

/**
 * Forget every record of one package. The stored artifacts are left alone.
 *
 * @param {string} name
 * @param {{root?: string}} [opts]
 * @returns {Promise<boolean>} whether a record was there to remove
 */
export async function removeInstalled(name, opts = {}) {
  const installs = await readInstalled(opts);
  const kept = installs.filter((record) => record.name !== name);
  if (kept.length === installs.length) return false;
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
