/**
 * SHA-256 helpers for plugin-share.
 *
 * Every artifact this plugin installs is identified by the digest of its exact
 * bytes, so the hash has to be taken over the file, never over a re-encoded or
 * re-downloaded copy.
 *
 * @module dsh-plugin-share/sha256
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Digest bytes as lowercase hex.
 *
 * @param {Uint8Array} bytes
 * @returns {string} 64 lowercase hex characters
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Digest a file by streaming it, so a large tarball never has to be held twice.
 *
 * @param {string} path
 * @returns {Promise<string>} 64 lowercase hex characters
 */
export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
