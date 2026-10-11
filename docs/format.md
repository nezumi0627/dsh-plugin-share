# The plugin-share format, version 1

This file is normative for `share: 1`. The schema is
[`schema/plugin-share.schema.json`](../schema/plugin-share.schema.json); the
implementation is [`lib/manifest.js`](../lib/manifest.js), and
[`test/manifest.test.mjs`](../test/manifest.test.mjs) keeps the two in step.

A shared plugin is two things: a **tarball** that a profile can install, and a
**manifest** that says what the tarball is and what its digest is.

## 1. The manifest, `plugin-share.json`

One schema, two forms. `share` is the format version and must be `1`.

### 1.1 Repository form

Sits next to the plugin's `package.json` in the author's repository, at the
repository root — `plugin-share.json`. This is what an installer reads.

| Field | Required | Meaning |
| --- | --- | --- |
| `share` | yes | `1`. The format version. |
| `name` | yes | The npm package name, exactly as `package/package.json` spells it. |
| `version` | yes | The released version, exactly as `package/package.json` spells it. |
| `summary` | no | One line describing the plugin. |
| `license` | no | SPDX identifier. |
| `author.github` | yes | The GitHub account that published it. |
| `author.name` | no | A display name. |
| `author.site` | no | The author's own site. |
| `created` | yes | ISO-8601 instant: when this version was made. |
| `artifact.format` | yes | `tgz`. |
| `artifact.sha256` | yes | 64 lowercase hex characters: the digest of the tarball bytes. |
| `artifact.url` | no | Where the tarball lives. Defaulted when omitted, see below. |
| `artifact.bytes` | no | The tarball's size, for a person to sanity-check. |

```json
{
  "share": 1,
  "name": "dsh-locale-ja",
  "version": "1.0.0",
  "summary": "Japanese (ja) language pack for the DSH Web GUI",
  "license": "MIT",
  "author": { "name": "nezumi0627", "github": "nezumi0627", "site": "https://example.com/" },
  "created": "2026-10-11T09:00:00.000Z",
  "artifact": {
    "url": "https://github.com/nezumi0627/dsh-locale-ja/releases/download/v1.0.0/dsh-locale-ja-1.0.0.tgz",
    "format": "tgz",
    "sha256": "3b1f0c9a...64 lowercase hex...",
    "bytes": 123456
  }
}
```

**`artifact.url` resolution.** When it is omitted, or relative, the installer
resolves it against the repository it read the manifest from:

```text
https://github.com/<owner>/<repo>/releases/download/v<version>/<file-name>-<version>.tgz
```

`<file-name>` is the npm name with the scope flattened: `@local/x-demo` packs to
`local-x-demo-1.0.0.tgz` in the `@local/x-demo` release. See
`artifactFileName()` in `lib/manifest.js`.

**`created` is not `installedAt`.** `created` says when the author made the
version: `pack` uses the directory's git commit date when it can read one, and the
current time otherwise. The person installing it records *their* time separately
as `installedAt` (§4). Both readings are supported on purpose.

**The digest covers the tarball's bytes, nothing else.** The manifest lives
outside the tarball, so it is not self-referential.

### 1.2 Embedded form

Inside the tarball, as `package/plugin-share.json`, with the same fields **minus
`artifact`** — a tarball cannot carry its own digest. `artifact` is *forbidden*
here, not merely ignored: a tarball whose embedded manifest claims a digest is
refused, because that claim cannot be true.

The embedded form is what makes a bare `.tgz` (handed over directly, with no
repository) still self-describing.

## 2. The tarball

- npm format, `npm pack` compatible: every entry is under `package/`, and
  `package/package.json` exists.
- `package/package.json` declares `dsh.bundle.patch`, and the file it names is
  present in the tarball. Without both, DSH could not load the package as a
  plugin, so the installer refuses it (`not-a-bundle`) instead of leaving a dead
  bundle in the profile.
- `package/plugin-share.json` carries the embedded manifest.
- **Dependencies are allowed.** They are declared normally in `package.json` and
  pnpm resolves them from the registry at install time. Shipping `node_modules`
  inside the tarball is allowed too.
- **No lifecycle scripts run while packing.** The tarball is written by this
  plugin's own dependency-free writer, so nothing in the author's environment
  (`prepack`, `prepare`, a different npm version, a different gzip) can change the
  bytes.
- Entry names are POSIX paths, `mtime` is fixed: packing the same directory twice
  produces the same bytes and therefore the same digest.

## 3. What an install verifies, in order

Each step has a machine-readable `code` on the refusal.

1. The source is understandable: a GitHub repository URL, a release tag URL, an
   https tarball URL, an absolute path to a `.tgz`, or `owner/name`.
2. The manifest is fetched (`plugin-share.json` in the repository) and matches
   the schema → `manifest-invalid`, `manifest-unreadable`.
3. `share` is a version this build knows → `unsupported-share`.
4. `artifact.sha256` is 64 lowercase hex → `sha256-invalid`.
5. A **bare tarball URL must come with a digest** from the author, because the
   response cannot vouch for itself → `sha256-required`. For a local `.tgz` the
   file's own bytes are the baseline, and this is reported as a warning instead.
6. The downloaded bytes hash to the published digest → `sha256-mismatch`, and
   **nothing is installed and nothing is written**.
7. The tarball's own name and version agree with the manifest →
   `manifest-mismatch`.
8. `dsh.bundle.patch` is declared and present → `not-a-bundle`.
9. Reading is safe: absolute entry names, `..` escapes, and link entries are
   refused, with caps on entry count, single-entry size, total size, and
   compressed size.
10. Nothing is extracted by this plugin. The verified local file is the only
    thing handed on, and it is handed on by absolute path — never by URL, so pnpm
    cannot silently re-fetch something else.
11. DSH peer compatibility is left to the profile's own installer
    (`installBundle`), which rolls the package back when it is incompatible.
12. If a dependency's install scripts need approval, the install stops with
    `pending-builds`, naming the packages. Re-running with those names approved
    (`approvedBuilds`) finishes the same attempt.

## 4. The install ledger, `installed.json`

Written under `$DSH_HOME/plugin-share/installed.json` (default
`~/.dsh/plugin-share/installed.json`). It is a versioned object, not a bare list,
so a later build can migrate it.

```json
{
  "share": 1,
  "installs": [
    {
      "name": "dsh-locale-ja",
      "version": "1.0.0",
      "source": { "input": "https://github.com/nezumi0627/dsh-locale-ja", "kind": "repo", "ref": "main" },
      "artifact": {
        "url": "https://github.com/nezumi0627/dsh-locale-ja/releases/download/v1.0.0/dsh-locale-ja-1.0.0.tgz",
        "sha256": "3b1f0c9a...",
        "path": "C:\\Users\\ren11\\.dsh\\plugin-share\\artifacts\\dsh-locale-ja\\1.0.0.tgz"
      },
      "author": { "name": "nezumi0627", "github": "nezumi0627", "site": "https://example.com/" },
      "created": "2026-10-11T09:00:00.000Z",
      "installedAt": "2026-10-11T10:00:00.000Z",
      "profileSpec": "file:C:/Users/ren11/.dsh/plugin-share/artifacts/dsh-locale-ja/1.0.0.tgz",
      "state": "installed"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `share` | `1`. The ledger format version. |
| `installs[]` | Every install this plugin recorded, oldest first, history included. |
| `source.input` | What the person actually passed. |
| `source.kind` | `repo`, `release`, `tarball-url`, or `local-tarball`. |
| `source.ref` | The git ref or tag, when the source named one. |
| `artifact.url` | Where the bytes came from. |
| `artifact.sha256` | The digest that was verified. |
| `artifact.path` | The verified copy kept in the store. |
| `author`, `created` | Copied from the manifest, so the ledger answers "whose, when" on its own. |
| `installedAt` | When it was installed here. |
| `profileSpec` | Exactly what the profile's `package.json` was given. |
| `state` | `installed`, `pending-builds`, `failed`, or `superseded`. |

`state`:

- `installed` — in the profile, digest verified.
- `pending-builds` — installed but a dependency's install scripts were not
  approved yet; the row is replaced when the approval finishes the attempt.
- `failed` — the attempt failed; the row keeps the error for the person to read.
- `superseded` — an older version of a name that has since been installed again.
  Kept as history; the current row is the last non-superseded one.

The ledger is a record, not a proof: it says what happened on this machine. What
protects a later install is the digest check, which is why `verify` re-hashes the
stored tarball instead of trusting the ledger.

**Do not delete `artifacts/` by hand.** Those files are the verified copies the
profile points at; removing one leaves the profile referencing a path that no
longer exists.

## 5. Versioning and compatibility

- `share` is bumped only for a change that older readers cannot interpret
  correctly. A reader refuses a version it does not know (`unsupported-share`)
  rather than guessing.
- Adding an optional field is not a break. Removing or renaming a required field,
  changing a field's meaning, or changing the digest's subject *is* a break: bump
  `share`, document it here, and teach the reader both versions.
- The schema and `lib/manifest.js` must be changed together, and
  `test/manifest.test.mjs` must keep failing when they disagree.
- A v1 tarball stays installable by later builds: nothing here depends on the
  plugin-share version that packed it.
