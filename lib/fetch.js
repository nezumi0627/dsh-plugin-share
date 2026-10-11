/**
 * Downloading an artifact, with the two rules this plugin needs.
 *
 * The digest check is only worth anything if the bytes that arrive are the bytes
 * that were hashed, so redirects are followed by hand and only to https, and a
 * response is abandoned as soon as it exceeds the size cap rather than after it
 * has been read into memory.
 *
 * @module dsh-plugin-share/fetch
 */
import { readFile, stat } from 'node:fs/promises';

/** Default cap for one artifact, matching the tarball reader's own cap. */
export const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Read a response body, refusing to grow past `maxBytes`. */
async function readBody(response, maxBytes, url) {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`fetch: ${url} is larger than the limit (${maxBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a URL into memory, following up to five https redirects.
 *
 * Every hop is checked for its scheme, the first one included: a share manifest
 * names its own `artifact.url`, so a plaintext or internal address would otherwise
 * be fetched on that manifest's say-so. `allowInsecure` exists for a local test
 * server, not for a manifest.
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, headers?: Record<string, string>, maxBytes?: number,
 *   allowInsecure?: boolean}} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fetchBytes(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowInsecure = opts.allowInsecure === true;
  const assertFetchable = (candidate, hop) => {
    if (allowInsecure || /^https:/i.test(candidate)) return;
    throw new Error(
      hop === 0
        ? `fetch: refusing to fetch a URL that is not https: ${candidate}`
        : `fetch: refusing to follow a redirect to a URL that is not https: ${candidate}`,
    );
  };
  let current = url;
  assertFetchable(current, 0);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, { redirect: 'manual', headers: opts.headers });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (location === null || location === '') {
        throw new Error(`fetch: ${current} answered ${response.status} without a location header`);
      }
      const next = new URL(location, current).toString();
      assertFetchable(next, 1);
      current = next;
      continue;
    }
    if (!response.ok) {
      const status = `${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`;
      throw new Error(`fetch: ${current} answered ${status}`);
    }
    return await readBody(response, maxBytes, current);
  }
  throw new Error(`fetch: ${url} redirected more than ${MAX_REDIRECTS} times`);
}

/**
 * Read a local file into memory, refusing one that is over the cap.
 *
 * @param {string} path
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<Buffer>}
 */
export async function readLocalFile(path, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`fetch: not a file: ${path}`);
  if (stats.size > maxBytes) {
    throw new Error(`fetch: ${path} is larger than the limit (${stats.size} > ${maxBytes})`);
  }
  return await readFile(path);
}
