/**
 * Turning whatever a person pastes into a source this plugin can act on.
 *
 * A source is a GitHub repository (optionally at a ref), a GitHub release tag, a
 * plain https tarball URL, a local tarball, or a local plugin directory. Anything
 * else is refused early, with the reason, so the installer never guesses.
 *
 * @module dsh-plugin-share/source
 */
import { isAbsolute } from 'node:path';
import { defaultArtifactUrl } from './manifest.js';

const GITHUB_TREE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/(.+?)\/?$/;
const GITHUB_RELEASE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/releases\/tag\/(.+?)\/?$/;
const GITHUB_REPO = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const TARBALL_NAME = /\.(?:tgz|tar\.gz)$/i;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const HAS_SCHEME = /^https?:\/\//i;

/**
 * @typedef {{kind: 'repo', owner: string, repo: string, ref: string | undefined, htmlUrl: string}
 *   | {kind: 'release', owner: string, repo: string, tag: string, htmlUrl: string}
 *   | {kind: 'tarball-url', url: string, filename: string}
 *   | {kind: 'local-tarball', path: string}
 *   | {kind: 'local-dir', path: string}} Source
 */

/**
 * Parse a source string.
 *
 * @param {string} input
 * @param {{allowInsecure?: boolean}} [opts] `allowInsecure` accepts http URLs,
 *   which this plugin refuses by default because an artifact fetched over http
 *   can be swapped before its digest is checked.
 * @returns {Source}
 */
export function parseSource(input, opts = {}) {
  const text = String(input ?? '').trim();
  if (text === '') throw new Error('source: the source must not be empty');
  if (/^http:\/\//i.test(text) && opts.allowInsecure !== true) {
    throw new Error('source: only https URLs are accepted; pass allowInsecure to override');
  }
  if (!HAS_SCHEME.test(text)) {
    if (!isAbsolute(text) && !WINDOWS_ABSOLUTE.test(text)) {
      throw new Error(`source: a local path must be absolute: ${text}`);
    }
    return TARBALL_NAME.test(text)
      ? { kind: 'local-tarball', path: text }
      : { kind: 'local-dir', path: text };
  }
  const tree = GITHUB_TREE.exec(text);
  if (tree) return { kind: 'repo', owner: tree[1], repo: tree[2], ref: tree[3], htmlUrl: text };
  const release = GITHUB_RELEASE.exec(text);
  if (release) return { kind: 'release', owner: release[1], repo: release[2], tag: release[3], htmlUrl: text };
  const repo = GITHUB_REPO.exec(text);
  if (repo) return { kind: 'repo', owner: repo[1], repo: repo[2], ref: undefined, htmlUrl: text };
  if (TARBALL_NAME.test(text)) {
    return { kind: 'tarball-url', url: text, filename: text.split('/').pop() };
  }
  throw new Error(`source: the URL must point at a GitHub repository or a tarball: ${text}`);
}

/**
 * Where the repository form of the manifest can be fetched for a source.
 *
 * @param {Source} source
 * @returns {string | undefined} undefined when the source is not a repository
 */
export function manifestUrlFor(source) {
  if (source.kind === 'repo') {
    const ref = source.ref ?? 'HEAD';
    return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${ref}/plugin-share.json`;
  }
  if (source.kind === 'release') {
    return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.tag}/plugin-share.json`;
  }
  return undefined;
}

/**
 * Where the tarball of a given version lives for a source.
 *
 * @param {Source} source
 * @param {string} name the package name
 * @param {string} version
 * @returns {string | undefined} undefined for a local directory, which the
 *   caller packs first and then treats as a local tarball
 */
export function artifactUrlFor(source, name, version) {
  if (source.kind === 'repo') {
    return defaultArtifactUrl({ owner: source.owner, repo: source.repo, tag: `v${version}`, name, version });
  }
  if (source.kind === 'release') {
    return defaultArtifactUrl({ owner: source.owner, repo: source.repo, tag: source.tag, name, version });
  }
  if (source.kind === 'tarball-url') return source.url;
  if (source.kind === 'local-tarball') return source.path;
  return undefined;
}
