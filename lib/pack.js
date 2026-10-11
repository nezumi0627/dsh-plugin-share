/**
 * Packing a plugin directory into a shareable artifact.
 *
 * This is the author's half: it reads the plugin's own `package.json` for
 * identity, refuses anything that could not load as a DSH bundle, and writes
 * two manifests and one npm-format tarball. The repository form carries the
 * digest of the tarball; the embedded form travels inside it and carries only
 * metadata, because a file cannot name its own digest.
 *
 * @module dsh-plugin-share/pack
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  artifactFileName,
  buildEmbeddedManifest,
  buildRepoManifest,
  defaultArtifactUrl,
  isValidPackageName,
  isValidVersion,
} from './manifest.js';
import { sha256Hex } from './sha256.js';
import { writeTarball } from './tgz-write.js';

const EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'dist', 'plugin-share.json']);
const EXCLUDED_SUFFIXES = ['.log'];
const EMBEDDED_MANIFEST_NAME = 'package/plugin-share.json';

function isExcluded(name) {
  return EXCLUDED_NAMES.has(name) || EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Walk a plugin directory into tarball entries under `package/`.
 *
 * Excluded: `.git`, `node_modules`, `dist`, `*.log`, and the repository form of
 * the manifest (it lives at the plugin root and must not ride inside its own
 * tarball). Names are posix paths; the order is sorted so the output is stable.
 *
 * @param {string} dir
 * @param {{exclude?: string[]}} [opts]
 * @returns {Array<{name: string, data: Buffer, mode: number}>}
 */
export function collectEntries(dir, opts = {}) {
  const alsoExcluded = new Set(opts.exclude ?? []);
  const entries = [];
  const walk = (relativeDir) => {
    const names = readdirSync(join(dir, relativeDir === '' ? '.' : relativeDir)).sort();
    for (const name of names) {
      if (isExcluded(name) || alsoExcluded.has(name)) continue;
      const relativePath = relativeDir === '' ? name : `${relativeDir}/${name}`;
      // lstat, not stat: a link is refused rather than followed, because following
      // one publishes the contents of whatever it points at (a key file inside a
      // cloned "plugin", say), and a directory link can be walked around a loop.
      const stats = lstatSync(join(dir, relativePath));
      if (stats.isSymbolicLink()) {
        throw new Error(
          `pack: refusing to pack the symbolic link ${relativePath}: its target's contents would be published`,
        );
      }
      if (stats.isDirectory()) {
        entries.push({ name: `package/${relativePath}/`, data: Buffer.alloc(0), mode: 0o755 });
        walk(relativePath);
        continue;
      }
      if (stats.isFile()) {
        entries.push({ name: `package/${relativePath}`, data: readFileSync(join(dir, relativePath)), mode: 0o644 });
      }
    }
  };
  walk('');
  return entries;
}

/** The commit date of the directory's HEAD, when it is a repository. */
function gitCommitDate(dir) {
  try {
    const output = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%cI'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output === '' ? undefined : output;
  } catch {
    return undefined;
  }
}

/**
 * Pack a plugin directory.
 *
 * @param {string} dir the plugin's source directory
 * @param {{owner: string, repo?: string, site?: string, authorName?: string,
 *   created?: string, outDir?: string, artifactUrl?: string, exclude?: string[]}} opts
 *   `owner` is the GitHub account that will host the share; `repo` defaults to
 *   the package name. `exclude` names extra top-level entries to keep out of the
 *   tarball (a working directory the repository itself ignores, for instance).
 * @returns {Promise<{tarballPath: string, tarballBytes: Buffer, sha256: string,
 *   repoManifest: object, embeddedManifest: object, manifestPath: string,
 *   warnings: string[]}>}
 */
export async function packDirectory(dir, opts) {
  let plugin;
  try {
    plugin = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`pack: cannot read package.json in ${dir}: ${error.message}`);
  }
  const patch = plugin.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || patch === '') {
    throw new Error('pack: package.json must declare dsh.bundle.patch');
  }
  if (!existsSync(join(dir, patch))) {
    throw new Error(`pack: the declared bundle patch does not exist: ${patch}`);
  }
  const { name, version } = plugin;
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    throw new Error('pack: package.json must name a package and a version');
  }
  // Both end up in the output filename, and one of them is a path segment: a name
  // carrying a separator or `..` would put the tarball outside the output
  // directory, so they are checked before anything is written.
  if (!isValidPackageName(name)) {
    throw new Error(`pack: package.json name is not a valid npm package name: ${JSON.stringify(name)}`);
  }
  if (!isValidVersion(version)) {
    throw new Error(`pack: package.json version is not a valid version: ${JSON.stringify(version)}`);
  }
  const owner = opts.owner;
  if (typeof owner !== 'string' || owner === '') {
    throw new Error('pack: the GitHub owner is required');
  }
  const repo = opts.repo ?? name.replace(/^@/, '').replace(/\//g, '-');
  const commitDate = gitCommitDate(dir);
  const created = opts.created ?? commitDate ?? new Date().toISOString();
  const author = { name: opts.authorName ?? owner, github: owner };
  if (opts.site !== undefined) author.site = opts.site;

  const embeddedManifest = buildEmbeddedManifest({
    name,
    version,
    summary: plugin.description,
    license: plugin.license,
    author,
    created,
  });
  const entries = [
    ...collectEntries(dir, { exclude: opts.exclude }),
    {
      name: EMBEDDED_MANIFEST_NAME,
      data: Buffer.from(`${JSON.stringify(embeddedManifest, null, 2)}\n`),
      mode: 0o644,
    },
  ];
  const mtimeMs = Number.isFinite(Date.parse(created)) ? Date.parse(created) : 0;
  const tarballBytes = writeTarball(entries, { mtimeMs });
  const sha256 = sha256Hex(tarballBytes);
  const repoManifest = buildRepoManifest({
    name,
    version,
    summary: plugin.description,
    license: plugin.license,
    author,
    created,
    artifact: {
      url: opts.artifactUrl ?? defaultArtifactUrl({ owner, repo, tag: `v${version}`, name, version }),
      sha256,
      bytes: tarballBytes.length,
    },
  });

  const outDir = opts.outDir ?? join(dir, 'dist');
  await mkdir(outDir, { recursive: true });
  const tarballPath = join(outDir, artifactFileName(name, version));
  await writeFile(tarballPath, tarballBytes);
  const manifestPath = join(dir, 'plugin-share.json');
  await writeFile(manifestPath, `${JSON.stringify(repoManifest, null, 2)}\n`);

  const warnings = [];
  if (opts.created === undefined && commitDate === undefined) {
    warnings.push(
      'this directory has no readable git commit date, so created is the current time and the digest is not reproducible; pass `created` (the CLI takes --created) to pin it',
    );
  }
  const dependencies = Object.keys(plugin.dependencies ?? {});
  if (dependencies.length > 0) {
    warnings.push(
      `the package declares dependencies, so installing it needs the npm registry: ${dependencies.join(', ')}`,
    );
  }
  return { tarballPath, tarballBytes, sha256, repoManifest, embeddedManifest, manifestPath, warnings };
}
