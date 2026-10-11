/**
 * The plugin-share manifest, in its two forms.
 *
 * `repo` is the authoritative form: it sits at the root of the shared repository
 * and carries the digest of the released tarball. `embedded` travels inside that
 * tarball, where it cannot name its own digest, so it carries metadata only. The
 * repository form is what an installer verifies against; the embedded form is
 * what a bare tarball URL can be read for.
 *
 * @module dsh-plugin-share/manifest
 */

/** The share-format version this build reads and writes. */
export const SHARE_VERSION = 1;

/** Top-level keys the repository form must carry. Kept in step with the JSON Schema. */
export const REPO_REQUIRED = ['share', 'name', 'version', 'author', 'created', 'artifact'];

/** Top-level keys the embedded form must carry. */
export const EMBEDDED_REQUIRED = ['share', 'name', 'version', 'author', 'created'];

const SHA256 = /^[0-9a-f]{64}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_NAME_MAX_LENGTH = 214;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether a string is a name the npm registry would accept.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidPackageName(name) {
  return (
    typeof name === 'string' &&
    name.length <= PACKAGE_NAME_MAX_LENGTH &&
    PACKAGE_NAME.test(name)
  );
}

function isIsoDateTime(value) {
  return typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Build the repository form.
 *
 * @param {{name: string, version: string, summary?: string, license?: string,
 *   author: {name?: string, github: string, site?: string}, created: string,
 *   artifact: {url?: string, sha256: string, bytes?: number}}} input
 * @returns {object}
 */
export function buildRepoManifest(input) {
  const artifact = { format: 'tgz', sha256: input.artifact.sha256 };
  if (input.artifact.url !== undefined) artifact.url = input.artifact.url;
  if (input.artifact.bytes !== undefined) artifact.bytes = input.artifact.bytes;
  const manifest = {
    share: SHARE_VERSION,
    name: input.name,
    version: input.version,
    author: { ...input.author },
    created: input.created,
    artifact,
  };
  if (input.summary !== undefined) manifest.summary = input.summary;
  if (input.license !== undefined) manifest.license = input.license;
  return manifest;
}

/**
 * Build the embedded form, which must not carry an `artifact` block.
 *
 * @param {{name: string, version: string, summary?: string, license?: string,
 *   author: {name?: string, github: string, site?: string}, created: string}} input
 * @returns {object}
 */
export function buildEmbeddedManifest(input) {
  const manifest = {
    share: SHARE_VERSION,
    name: input.name,
    version: input.version,
    author: { ...input.author },
    created: input.created,
  };
  if (input.summary !== undefined) manifest.summary = input.summary;
  if (input.license !== undefined) manifest.license = input.license;
  return manifest;
}

/**
 * The release-asset filename of a version: npm's own convention, with a scope's
 * slash and leading `@` removed so the name survives a URL path and a release page.
 *
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function artifactFileName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

/**
 * The default download URL of a version's release asset.
 *
 * @param {{owner: string, repo: string, tag: string, name: string, version: string}} input
 * @returns {string}
 */
export function defaultArtifactUrl(input) {
  const asset = artifactFileName(input.name, input.version);
  return `https://github.com/${input.owner}/${input.repo}/releases/download/${input.tag}/${asset}`;
}

/**
 * Validate a manifest against one form.
 *
 * @param {unknown} value
 * @param {'repo' | 'embedded'} form
 * @returns {{ok: true, manifest: object} | {ok: false, errors: string[]}}
 */
export function validateManifest(value, form) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['the manifest must be a JSON object'] };
  }
  const errors = [];
  for (const key of form === 'embedded' ? EMBEDDED_REQUIRED : REPO_REQUIRED) {
    if (!(key in value)) errors.push(`missing required key: ${key}`);
  }
  if (value.share !== SHARE_VERSION) errors.push(`share must be ${SHARE_VERSION}`);
  if (!isValidPackageName(value.name)) errors.push('name must be a valid npm package name');
  if (typeof value.version !== 'string' || value.version.trim() === '') {
    errors.push('version must be a non-empty string');
  }
  if (!isIsoDateTime(value.created)) errors.push('created must be an ISO 8601 date-time');
  const author = value.author;
  if (author === null || typeof author !== 'object' || Array.isArray(author)) {
    errors.push('author must be an object');
  } else if (typeof author.github !== 'string' || author.github.trim() === '') {
    errors.push('author.github must be a non-empty string');
  }
  if (form === 'embedded') {
    if ('artifact' in value) errors.push('an embedded manifest must not carry an artifact block');
  } else {
    const artifact = value.artifact;
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      errors.push('artifact must be an object');
    } else {
      if (artifact.format !== 'tgz') errors.push('artifact.format must be "tgz"');
      if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
        errors.push('artifact.sha256 must be 64 lowercase hex characters');
      }
      if (artifact.url !== undefined && typeof artifact.url !== 'string') {
        errors.push('artifact.url must be a string');
      }
      if (artifact.bytes !== undefined && !Number.isInteger(artifact.bytes)) {
        errors.push('artifact.bytes must be an integer');
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: value };
}
