/**
 * The `plugin_share` agent tool.
 *
 * The definition is a plain object, in the shape the tool registry takes, so this
 * plugin never imports a first-party package: `parameters` and `output.schema`
 * are JSON Schema, `execute` returns the string the model reads.
 *
 * @module dsh-plugin-share/tool
 */
import { installShare, inspectShare } from './install.js';
import { findInstalled, readInstalled, removeInstalled, verifyArtifact } from './store.js';

/** The name the agent calls. */
export const TOOL_NAME = 'plugin_share';

const ACTIONS = ['inspect', 'install', 'verify', 'list', 'remove'];

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`plugin_share: ${field} is required for this action`);
  }
  return value;
}

/**
 * Build the tool.
 *
 * @param {{installer: {installedNames: Function, installBundle: Function, removeBundle: Function},
 *   root?: string, fetchImpl?: typeof fetch, mode?: string | ((exec: object) => string)}} deps
 *   `mode` is the effective sandbox mode; every action refuses unless it is
 *   `danger-full-access`, because an install runs the profile's package manager
 *   and changes every session in this profile.
 * @returns {object} a registry-ready tool definition
 */
export function makeTool(deps) {
  const resolveMode = typeof deps.mode === 'function' ? deps.mode : () => deps.mode;
  const root = deps.root;

  const assertAllowed = (exec) => {
    const mode = resolveMode(exec) ?? 'workspace-write';
    if (mode !== 'danger-full-access') {
      throw new Error(
        `plugin_share: this action needs the danger-full-access permission, and this call has ${mode}. ` +
          'Installing a shared plugin changes the profile and runs its install scripts.',
      );
    }
  };

  const listInstalled = async () => {
    const records = await readInstalled({ root });
    const names = deps.installer === undefined ? [] : await deps.installer.installedNames();
    const entries = records.map((record) => ({
      name: record.name,
      version: record.version,
      sha256: record.sha256,
      installedAt: record.installedAt,
      source: record.source,
      status: record.status,
      inProfile: names.includes(record.name),
    }));
    return {
      ok: true,
      status: 'listed',
      total: entries.length,
      entries,
      inProfileNotRecorded: names.filter((name) => !records.some((record) => record.name === name)),
    };
  };

  const verify = async (name) => {
    const record = await findInstalled(name, { root });
    if (record === undefined) {
      return { ok: false, status: 'unknown', name, message: `no install record for ${name}; run list first` };
    }
    const result = await verifyArtifact(name, record.version, record.sha256, { root });
    if (result.ok) {
      return { ok: true, status: 'verified', name, version: record.version, sha256: record.sha256, artifactPath: result.path };
    }
    if (result.reason === 'missing') {
      return {
        ok: false,
        status: 'artifact-missing',
        name,
        version: record.version,
        sha256: record.sha256,
        message: 'the verified tarball is no longer in the store, so this install cannot be re-checked; reinstall from its source',
      };
    }
    return {
      ok: false,
      status: 'sha256-mismatch',
      name,
      version: record.version,
      expected: record.sha256,
      actual: result.actual,
      artifactPath: result.path,
      message: 'the stored tarball no longer matches the digest it was installed with; treat this profile as suspect',
    };
  };

  const remove = async (name) => {
    const names = await deps.installer.installedNames();
    const inProfile = names.includes(name);
    if (inProfile) await deps.installer.removeBundle(name);
    const hadRecord = await removeInstalled(name, { root });
    if (!inProfile && !hadRecord) {
      return { ok: false, status: 'not-found', name, message: `${name} is neither in the profile nor in the install ledger` };
    }
    return { ok: true, status: inProfile ? 'removed' : 'record-removed', name, inProfile, hadRecord };
  };

  return {
    name: TOOL_NAME,
    description:
      'Inspect, install, verify, list, or remove a plugin shared with plugin-share. An install downloads the ' +
      'artifact, checks its sha256 against the digest the author published, and only then lets the profile ' +
      'install it. Every action requires danger-full-access permission: an install changes the profile for ' +
      'every session and can run the plugin\u2019s install scripts. Sources are a GitHub repository URL, a ' +
      'release tag URL, an https tarball URL (which then needs the author\u2019s sha256), an absolute path to ' +
      'a .tgz, or a repository owner/name pair. Use inspect first to see what a source would install and to ' +
      'learn a tarball URL\u2019s digest. Installing over an existing package name needs replace.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'inspect: read the manifest and report what an install would do. install: download, verify, and install. verify: re-hash an installed artifact against its recorded digest. list: the install ledger with each entry\u2019s profile state. remove: take a bundle out of the profile and forget its record.',
        },
        source: {
          type: 'string',
          description:
            'For inspect and install: a GitHub repository URL, a release tag URL, an https tarball URL, or an absolute path to a local .tgz.',
        },
        sha256: {
          type: 'string',
          description:
            'For a bare tarball URL: the 64-character lowercase hex digest the author published. Required for those sources, because a tarball carries no digest of its own.',
        },
        replace: {
          type: 'boolean',
          description: 'For install: install over an existing package of the same name, replacing it.',
        },
        approvedBuilds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For install: package names whose install scripts the user has explicitly approved in this conversation, taken from a previous call\u2019s pendingBuilds.',
        },
        name: { type: 'string', description: 'For verify and remove: the installed package name.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      assertAllowed(exec);
      switch (args.action) {
        case 'inspect': {
          const inspected = await inspectShare(required(args.source, 'source'), {
            installer: deps.installer,
            root,
            fetchImpl: deps.fetchImpl,
            sha256: args.sha256,
          });
          if (!inspected.ok) return JSON.stringify(inspected, null, 2);
          const inspection = inspected.inspection;
          return JSON.stringify(
            {
              ok: true,
              status: 'inspected',
              source: inspection.sourceLabel,
              form: inspection.form,
              name: inspection.name,
              version: inspection.version,
              sha256: inspection.sha256,
              artifactUrl: inspection.artifactUrl,
              author: inspection.manifest?.author,
              alreadyInstalled: inspection.alreadyInstalled,
              warnings: inspection.warnings,
              next:
                inspection.alreadyInstalled && inspection.installedRecord?.status !== 'pending-builds'
                  ? 'installing this source again needs replace'
                  : 'call install with this source to install it',
            },
            null,
            2,
          );
        }
        case 'install': {
          const result = await installShare(required(args.source, 'source'), {
            installer: deps.installer,
            root,
            fetchImpl: deps.fetchImpl,
            sha256: args.sha256,
            replace: args.replace,
            approvedBuilds: args.approvedBuilds,
          });
          return JSON.stringify(result, null, 2);
        }
        case 'verify':
          return JSON.stringify(await verify(required(args.name, 'name')), null, 2);
        case 'list':
          return JSON.stringify(await listInstalled(), null, 2);
        case 'remove':
          return JSON.stringify(await remove(required(args.name, 'name')), null, 2);
        default:
          throw new Error(`plugin_share: unknown action ${JSON.stringify(args.action)}`);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Share a plugin',
      kind: args.action === 'install' || args.action === 'remove' ? 'other' : 'read',
      rawInput: args,
    }),
  };
}
