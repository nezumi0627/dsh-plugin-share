import { collectEntries } from './pack.js';

const SAMPLE_ENV = /^\.env\.(?:example|sample|template|dist)$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|service-account[^/]*\.json|[^/]+\.(?:pem|p12|pfx|key|tfstate))$/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
];
// Only inspect literal values. Matching arbitrary JavaScript expressions such as
// readFileSync(...) mistakes safe secret-loading code for an embedded secret.
const ASSIGNMENT = /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key)(?:[_-][A-Za-z0-9]+)*\s*[:=]\s*["'`]?([^\s"'`,;]{16,})/i;
const NPM_AUTH = /\b_authToken\s*=\s*["']?[^\s"']{12,}/i;
const PLACEHOLDER = /^(?:replace[-_ ]?me|your[-_ ].*|example|changeme|placeholder|<.*>|test[-_].*|dummy[-_].*|not[-_ ]a[-_ ]real[-_ ].*)$/i;

function hasSecretContent(content) {
  const text = content.toString('utf8');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (NPM_AUTH.test(text)) return true;
  return text.split(/\r?\n/).some((line) => {
    // A function result is a reference to a value, not a credential literal.
    if (/\b(?:secret|password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token)\s*=\s*[A-Za-z_$][\w$]*\s*\(/i.test(line)) return false;
    const match = ASSIGNMENT.exec(line);
    if (!match) return false;
    const value = match[1].replace(/["'`]+$/, '');
    return value.length >= 16 && !PLACEHOLDER.test(value);
  });
}

/** Refuse publication when an included path or its contents look credential-bearing. */
export function assertNoSecrets(dir) {
  const findings = [];
  for (const entry of collectEntries(dir)) {
    if (entry.name.endsWith('/')) continue;
    const path = entry.name.slice('package/'.length);
    const safeSample = SAMPLE_ENV.test(path);
    if (!safeSample && SENSITIVE_PATH.test(path)) findings.push(`${path} (sensitive filename)`);
    else if (hasSecretContent(entry.data)) findings.push(`${path} (credential-like content)`);
  }
  if (findings.length > 0) {
    const shown = findings.slice(0, 10).join(', ');
    const remainder = findings.length > 10 ? `, and ${findings.length - 10} more` : '';
    throw new Error(`Sharing blocked: possible credentials found in ${shown}${remainder}. Remove the credentials or exclude the file before sharing.`);
  }
  return true;
}
