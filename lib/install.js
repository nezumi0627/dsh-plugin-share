/**
 * Inspecting and installing a shared plugin.
 *
 * The order matters and is the whole point of this module: resolve the source,
 * learn the digest that was published, download the bytes, compare the digest,
 * and only then let the profile install. A refusal at any step leaves the
 * profile and the install ledger untouched.
 *
 * @module dsh-plugin-share/install
 */
import { fetchBytes, readLocalFile } from './fetch.js';
import { validateManifest } from './manifest.js';
import { artifactUrlFor, manifestUrlFor, parseSource } from './source.js';
import { sha256Hex } from './sha256.js';
import { findInstalled, recordInstall, removeArtifact, storeArtifact } from './store.js';
import { readEntry } from './tgz-read.js';

const SHA256 = /^[0-9a-f]{64}$/;
const EMBEDDED_MANIFEST = 'package/plugin-share.json';
const PACKAGE_MANIFEST = 'package/package.json';
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

/** A refusal the person can act on, as opposed to a bug or a network failure. */
export class Refusal extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'Refusal';
  }
}

/**
 * The spec the profile records for a verified local tarball.
 *
 * @param {string} path an absolute path
 * @returns {string} pnpm's `file:` form, with forward slashes on every platform
 */
export function toPnpmSpec(path) {
  return `file:${path.replace(/\\/g, '/')}`;
}

function resolveSource(input, opts) {
  if (input !== null && typeof input === 'object' && typeof input.kind === 'string') return input;
  return parseSource(input, opts);
}

function describeSource(input, source) {
  if (typeof input === 'string') return input;
  return source.htmlUrl ?? source.url ?? source.path ?? '';
}

function failure(error) {
  if (error instanceof Refusal) {
    return { ok: false, status: 'refused', code: error.code, message: error.message };
  }
  return { ok: false, status: 'error', message: `${error.name}: ${error.message}` };
}

async function loadRemote(url, opts) {
  return await fetchBytes(url, {
    fetchImpl: opts.fetchImpl,
    headers: opts.headers,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    allowInsecure: opts.allowInsecure === true,
  });
}

async function loadBytes(scope, source, opts) {
  if (source.kind === 'tarball-url') return await loadRemote(source.url, opts);
  return await readLocalFile(source.path, { maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES });
}

/** The metadata a tarball carries about itself: an embedded manifest, or its package.json. */
function readTarballMetadata(bytes) {
  const packageEntry = readEntry(bytes, PACKAGE_MANIFEST);
  let packageJson;
  if (packageEntry !== undefined) {
    try {
      packageJson = JSON.parse(packageEntry.toString('utf8'));
    } catch {
      packageJson = undefined;
    }
  }
  const embedded = readEntry(bytes, EMBEDDED_MANIFEST);
  if (embedded !== undefined) {
    try {
      return { origin: 'embedded', value: JSON.parse(embedded.toString('utf8')), packageJson };
    } catch {
      return { origin: 'embedded-unreadable', value: undefined, packageJson };
    }
  }
  if (packageJson !== undefined) {
    return { origin: 'package', value: { name: packageJson.name, version: packageJson.version }, packageJson };
  }
  return { origin: 'absent', value: undefined, packageJson };
}

/** The tarball entry a declared bundle patch has to exist at. */
function patchEntryName(patch) {
  return `package/${patch.replace(/^\.\//, '').replace(/\\/g, '/')}`;
}

/**
 * Refuse a tarball DSH could not load as a plugin, before anything is installed.
 *
 * pnpm would happily install a plain npm package, and the profile would then carry
 * a bundle that never activates, so this is checked here rather than after.
 */
function assertIsBundle(bytes, metadata) {
  const patch = metadata.packageJson?.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || patch === '') {
    throw new Refusal(
      'not-a-bundle',
      'the tarball\'s package.json does not declare dsh.bundle.patch, so DSH could not load it as a plugin',
    );
  }
  if (readEntry(bytes, patchEntryName(patch)) === undefined) {
    throw new Refusal(
      'not-a-bundle',
      `the tarball declares dsh.bundle.patch ${patch}, but it carries no ${patchEntryName(patch)}`,
    );
  }
}

/**
 * Work out what installing a source would do, without doing any of it.
 *
 * @param {string | object} input a source string, or an already-parsed source
 * @param {{fetchImpl?: typeof fetch, headers?: Record<string, string>, maxBytes?: number,
 *   sha256?: string, root?: string, installer?: object, allowInsecure?: boolean}} [opts]
 * @returns {Promise<{ok: true, inspection: object} | {ok: false, status: string, code?: string, message: string}>}
 */
export async function inspectShare(input, opts = {}) {
  try {
    const source = resolveSource(input, opts);
    const warnings = [];
    if (source.kind === 'local-dir') {
      throw new Refusal(
        'source-is-a-directory',
        `${source.path} is a local directory; run \`plugin-share pack ${source.path}\` first and share the repository or the tarball`,
      );
    }
    const label = describeSource(input, source);
    if (source.kind === 'repo' || source.kind === 'release') {
      const manifestUrl = manifestUrlFor(source);
      const text = (await loadRemote(manifestUrl, opts)).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Refusal('manifest-unreadable', `${manifestUrl} is not JSON: ${error.message}`);
      }
      const validated = validateManifest(parsed, 'repo');
      if (!validated.ok) {
        throw new Refusal(
          'manifest-invalid',
          `${manifestUrl} is not a share manifest: ${validated.errors.join('; ')}`,
        );
      }
      const manifest = validated.manifest;
      const artifactUrl = manifest.artifact.url ?? artifactUrlFor(source, manifest.name, manifest.version);
      const existing = opts.installer === undefined ? [] : await opts.installer.installedNames();
      const installed = await findInstalled(manifest.name, { root: opts.root });
      return {
        ok: true,
        inspection: {
          source,
          sourceLabel: label,
          form: 'repo',
          manifest,
          name: manifest.name,
          version: manifest.version,
          artifactUrl,
          sha256: manifest.artifact.sha256,
          alreadyInstalled: existing.includes(manifest.name),
          installedRecord: installed,
          warnings,
        },
      };
    }

    const bytes = await loadBytes(label, source, opts);
    const expected = opts.sha256;
    if (expected !== undefined && !SHA256.test(expected)) {
      throw new Refusal('sha256-invalid', 'the expected sha256 must be 64 lowercase hex characters');
    }
    const actual = sha256Hex(bytes);
    if (expected === undefined) {
      if (source.kind === 'tarball-url') {
        throw new Refusal(
          'sha256-required',
          `a bare tarball URL carries no digest of its own; pass the sha256 the author published (this file hashes to ${actual})`,
        );
      }
      warnings.push('no digest was given for this local file, so nothing was compared against it');
    } else if (expected !== actual) {
      throw new Refusal('sha256-mismatch', `the bytes hash to ${actual}, not the expected ${expected}`);
    }
    const metadata = readTarballMetadata(bytes);
    if (metadata.origin === 'embedded') {
      const validated = validateManifest(metadata.value, 'embedded');
      if (!validated.ok) {
        throw new Refusal('manifest-invalid', `the tarball's manifest is not valid: ${validated.errors.join('; ')}`);
      }
    }
    const value = metadata.value;
    if (value === undefined || typeof value.name !== 'string' || typeof value.version !== 'string') {
      throw new Refusal(
        'manifest-absent',
        'the tarball carries neither a share manifest nor a package.json, so its name and version are unknown',
      );
    }
    assertIsBundle(bytes, metadata);
    warnings.push('this artifact was not checked against a repository manifest');
    const existing = opts.installer === undefined ? [] : await opts.installer.installedNames();
    const installed = await findInstalled(value.name, { root: opts.root });
    return {
      ok: true,
      inspection: {
        source,
        sourceLabel: label,
        form: metadata.origin === 'embedded' ? 'embedded' : 'package',
        manifest: value,
        name: value.name,
        version: value.version,
        artifactUrl: source.kind === 'tarball-url' ? source.url : source.path,
        sha256: expected ?? actual,
        bytes,
        alreadyInstalled: existing.includes(value.name),
        installedRecord: installed,
        warnings,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Compare a repository manifest with the metadata inside the tarball it points at. */
function assertTarballAgrees(bytes, name, version) {
  const metadata = readTarballMetadata(bytes);
  const value = metadata.value;
  if (value !== undefined && typeof value === 'object') {
    if (typeof value.name === 'string' && value.name !== name) {
      throw new Refusal('manifest-mismatch', `the manifest says ${name}, but the tarball carries ${value.name}`);
    }
    if (typeof value.version === 'string' && value.version !== version) {
      throw new Refusal('manifest-mismatch', `the manifest says ${version}, but the tarball carries ${value.version}`);
    }
  }
  assertIsBundle(bytes, metadata);
}

/**
 * Read what the profile's installer reported.
 *
 * The real `pluginManager.installBundle`/`removeBundle` answer with
 * `{changed, application, stage, target, error?}`: there is no `ok` field, and
 * `error` is `{code, diagnostic}`, not a sentence. Installers in tests may answer
 * `{ok: true}`. Both are accepted, and an unrecognizable answer is treated as a
 * refusal rather than as success.
 *
 * @param {unknown} result
 * @param {{allowUnreported?: boolean}} [opts] `allowUnreported` accepts a missing
 *   report, for a caller that can check the profile itself.
 * @returns {{ok: boolean, message?: string, code?: string, restartRequired?: boolean,
 *   warnings?: string[], unreported?: boolean}}
 */
export function readInstallerOutcome(result, opts = {}) {
  if (result === null || result === undefined) {
    return opts.allowUnreported === true
      ? { ok: true, unreported: true }
      : { ok: false, message: 'the profile installer returned nothing, so nothing can be claimed about the install' };
  }
  if (typeof result !== 'object') {
    return { ok: false, message: `the profile installer returned ${typeof result}, which is not a result` };
  }
  if (result.error !== undefined && result.error !== null) {
    const parts =
      typeof result.error === 'string'
        ? [result.error]
        : [result.error.code, result.error.diagnostic].filter((part) => typeof part === 'string' && part !== '');
    return {
      ok: false,
      ...(typeof result.error === 'object' && typeof result.error.code === 'string' ? { code: result.error.code } : {}),
      message: parts.length === 0 ? 'the profile installer refused the bundle' : parts.join(': '),
    };
  }
  if (result.application === 'failed') {
    return { ok: false, code: 'operation-error', message: `${result.stage ?? 'the install'} failed in the profile` };
  }
  if (result.application === 'cancelled') {
    return { ok: false, code: 'cancelled', message: 'the install was cancelled before it was applied' };
  }
  const known = ['applied', 'restart-required', 'overridden'];
  if (typeof result.application === 'string' && !known.includes(result.application)) {
    return { ok: false, message: `the profile installer reported "${result.application}"` };
  }
  if (result.application === undefined && result.ok !== true) {
    return { ok: false, message: 'the profile installer returned an unrecognizable result' };
  }
  return {
    ok: true,
    ...(result.application === 'restart-required' ? { restartRequired: true } : {}),
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

/**
 * Install a shared plugin into the profile.
 *
 * @param {string | object} input
 * @param {{installer: {installedNames: Function, installBundle: Function, removeBundle: Function},
 *   fetchImpl?: typeof fetch, headers?: Record<string, string>, maxBytes?: number, sha256?: string,
 *   root?: string, replace?: boolean, approvedBuilds?: string[], now?: string, allowInsecure?: boolean}} opts
 * @returns {Promise<{ok: boolean, status: string, code?: string, message?: string, name?: string,
 *   version?: string, sha256?: string, artifactPath?: string, pendingBuilds?: string[], warnings?: string[]}>}
 */
export async function installShare(input, opts = {}) {
  const inspected = await inspectShare(input, opts);
  if (!inspected.ok) return inspected;
  const inspection = inspected.inspection;
  const { name, version } = inspection;
  try {
    const installer = opts.installer;
    if (installer === undefined) throw new Error('installShare: an installer is required');
    const bytes = inspection.bytes ?? (await loadRemote(inspection.artifactUrl, opts));
    const actual = sha256Hex(bytes);
    if (actual !== inspection.sha256) {
      throw new Refusal(
        'sha256-mismatch',
        `the bytes hash to ${actual}, not the expected ${inspection.sha256}`,
      );
    }
    assertTarballAgrees(bytes, name, version);

    const resumeBuilds =
      inspection.installedRecord?.state === 'pending-builds' &&
      (opts.approvedBuilds?.length ?? 0) > 0;
    const names = await installer.installedNames();
    if (names.includes(name) && !resumeBuilds && opts.replace !== true) {
      return {
        ok: false,
        status: 'already-installed',
        name,
        version,
        message: `${name} is already in the profile; pass replace to install this version over it`,
      };
    }

    const artifactPath = await storeArtifact(name, version, bytes, { root: opts.root });
    const profileSpec = toPnpmSpec(artifactPath);
    const result = await installer.installBundle(profileSpec, {
      approvedBuilds: opts.approvedBuilds,
      enabled: true,
    });
    const outcome = readInstallerOutcome(result);
    if (!outcome.ok) {
      // The profile never took the bundle, so the copy written for it would be a
      // file nothing refers to. A throw from the installer is different: there the
      // profile's state is unknown, and the artifact may be what it points at.
      await removeArtifact(name, version, { root: opts.root });
      return {
        ok: false,
        status: 'install-failed',
        name,
        version,
        artifactPath,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        message: outcome.message,
      };
    }
    const pendingBuilds = result.pendingBuilds ?? [];
    const installerWarnings = outcome.warnings ?? [];
    const author = inspection.manifest?.author;
    const record = {
      name,
      version,
      source: {
        input: inspection.sourceLabel,
        kind: inspection.source.kind,
        ...(inspection.source.ref === undefined ? {} : { ref: inspection.source.ref }),
      },
      artifact: { url: inspection.artifactUrl, sha256: actual, path: artifactPath },
      ...(author === undefined ? {} : { author }),
      ...(inspection.manifest?.created === undefined ? {} : { created: inspection.manifest.created }),
      installedAt: opts.now ?? new Date().toISOString(),
      profileSpec,
      state: pendingBuilds.length > 0 ? 'pending-builds' : 'installed',
    };
    await recordInstall(record, { root: opts.root });
    if (pendingBuilds.length > 0) {
      return {
        ok: false,
        status: 'builds-pending',
        name,
        version,
        artifactPath,
        pendingBuilds,
        message: `the profile needs approval to run build scripts: ${pendingBuilds.join(', ')}`,
      };
    }
    return {
      ok: true,
      status: 'installed',
      name,
      version,
      sha256: actual,
      artifactPath,
      ...(outcome.restartRequired === true
        ? {
            restartRequired: true,
            message: `${name}@${version} is in the profile; restart DSH to load it`,
          }
        : {}),
      warnings: [...inspection.warnings, ...installerWarnings],
    };
  } catch (error) {
    return failure(error);
  }
}
