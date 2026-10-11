# Verification log

What was actually run, what it showed, and what it did **not** show. Environment:
Windows, Node v24.14.0, pnpm 11.7.0, `gh` authenticated as `nezumi0627`,
`node --test` for every suite.

## 1. The test suite

```text
$ node --test
ℹ tests 130
ℹ pass 130
ℹ fail 0
```

(as of commit `f32f139`, the commit tag `v0.1.0` points at)

Covered: manifest validation for both forms (schema required fields are asserted
to be exactly the ones the validator enforces), tarball read/write round-trips
against the npm format, reading safety (absolute names, `..`, links, caps),
sha256 digests, source parsing for every input form, redirect and size limits in
the fetcher, the store and the ledger, every install path with a fake installer
(digest match, digest mismatch, bare URL without a digest, manifest/tarball
disagreement, a tarball that would not load as a bundle, build approval
round-trip, replacement, refusal), the `plugin_share` tool's five actions and its
`danger-full-access` refusal, the CLI, the publish planner, and the web host and
client halves with a fake web server and a fake React.

## 2. The release, checked four ways

The digest of the published tarball is recorded in `plugin-share.json` at the
repository root — **not here**. `pack` writes that file and excludes it from the
tarball, so the record lives outside the artifact it describes and can never
disagree with itself. Read the digest from there, then check it four ways:

```text
$ node bin/plugin-share.mjs pack . --owner nezumi0627 --repo dsh-plugin-share --exclude .superpowers
packed dsh-plugin-share@0.1.0
sha256 <written into plugin-share.json>
bytes <same file>

$ (Get-FileHash dist\dsh-plugin-share-0.1.0.tgz -Algorithm SHA256).Hash
<plugin-share.json's artifact.sha256>

$ gh release view v0.1.0 --json assets
"digest": "sha256:<the same>"
"size": <artifact.bytes>

$ curl -sL -o curl.tgz https://github.com/nezumi0627/dsh-plugin-share/releases/download/v0.1.0/dsh-plugin-share-0.1.0.tgz
<the same digest, and artifact.bytes bytes>
```

So four independent readings agree: the packer, Windows' own SHA256, GitHub's API
digest, and a fresh download of the release asset.

The 0.1.0 asset was replaced once, after the installer-result fix (commit
`c6f87b6`): the first build's digest identified bytes that would have reported a
successful profile install as a failure, so it was withdrawn rather than left as
the recommended artifact. `pack` is deterministic for a given directory *and*
commit date — `created` comes from the commit — so a rebuild of the same tree
reproduces the same digest, and any later commit legitimately produces a new one.

The tarball holds 40 entries: every source file plus `package/plugin-share.json`
(the embedded manifest). It contains no `.superpowers/` working directory, no
`dist/`, and no `node_modules`.

`git rev-parse v0.1.0` → `f32f139…`, the same commit that was packed, so the tag
and the published bytes describe one tree.

## 3. pnpm accepts the tarball

Run in a throwaway workspace under `%TEMP%`, not in the live profile:

```text
$ node <…>/pnpm.mjs add "file:C:/…/dist/dsh-plugin-share-0.1.0.tgz" --dir %TEMP%\ps-pnpm
Packages: +1
+ dsh-plugin-share 0.1.0
Done in 945ms using pnpm v11.7.0
```

- `package.json` afterwards: `"dsh-plugin-share": "file:C:/…/dist/dsh-plugin-share-0.1.0.tgz"` —
  pnpm records the `file:` spec **verbatim, absolute and with forward slashes**.
  That answers the design's open question about `profileSpec`: `toPnpmSpec()`'s
  output is what the profile will carry.
- `node_modules/.bin/plugin-share{,.CMD,.ps1}` was linked, so the `bin` entry
  survives the tarball.
- All 40 entries landed (`index.js`, `lib/`, `client.js`, `cordis.patch.yml`,
  `schema/`, …).
- No dependency resolution happened: the tarball declares none, and no registry
  was contacted.

## 5. The host API, read from the real package

`@deepseek-ai/dsh-plugin-manager` was read in the installed DSH tree
(`_asar_full/dsh/node_modules/@deepseek-ai/dsh-plugin-manager`, version
`0.2.0-rc.2`) rather than guessed, because the design flagged the host's exact
result shapes as unknown. Two defects were found that way and fixed:

- `installBundle(spec, options)` returns
  `{changed, application, stage, target, error?: {code, diagnostic}, warnings?,
  pendingBuilds?, approvedBuilds?, packageResult?, bundle?}` — **there is no `ok`
  field.** The code had required `result.ok === true`, so every real install would
  have been reported as a failure. It now reads `application` / `error`, treats an
  unrecognizable result as a refusal, and still accepts `{ok: true}` from a simple
  adapter.
- `error` is an object, not a sentence. A refusal used to be reported as
  `[object Object]`; it now reads `code: diagnostic` (for example
  `incompatible-version: peer @deepseek-ai/cordis is 4.0.4`).

Also confirmed:

- `listBundles()` rows carry `name`, `version?`, `enabled`, `installed`, `rows[]` —
  the adapter's `row.name` is right, and the bundle name is what the profile lists.
- `installBundle`'s options are `{enabled, requestId, approvedBuilds, registry}`;
  the call passes `enabled: true` and `approvedBuilds` on a retry.
- Awaiting `installBundle` **is** the whole operation — DSH's own `plugin_manager`
  tool does exactly `await manager.installBundle(...)`. `requestId` and
  `waitForInstall` are only for cancellation and progress, so not passing them is
  fine.
- `removeBundle(name)` answers with the same shape, so a failed removal is now
  reported (`remove-failed`) and the ledger row is kept instead of claiming
  success.
- Where the tool comes from: `tool-plugin-manager` is `disabled: true` in
  `@deepseek-ai/dsh-web-app/cordis.patch.yml` and re-enabled by
  `presets/cordis.patch.yml` as `@deepseek-ai/dsh-plugin-manager/tools`, disabled
  only when there is no `profileContext`. The `ui-plugin-manager` client entry (the
  sidebar Plugins page, which declares `plugins.detail.actions`) is in the main
  patch, so the page exists in the Web app.
- The slot's documented subject is `{kind: 'bundle', pkg}` where `pkg` carries
  name, version, installed and enabled — matching what the Share button reads.

## 6. What is **not** verified yet

These need a live DSH profile, and the session that wrote this had no
`plugin_manager` tool, so they are still open:

1. **Bootstrap (acceptance 6).** Installing this release through
   `plugin_manager`'s `install_bundle` and seeing `dsh-plugin-share` in
   `dsh.profile.bundles` and `plugin_share` in the agent's tool list. Everything
   up to the installer call is verified; the installer call itself is not.
2. **Whether a profile-level tool is visible to the agent** without a preset
   edit, and **whether a newly installed bundle needs a restart** rather than
   being picked up live.
3. **`installBundle`'s exact behavior for a local tarball** — success shape and
   whether it reports `already-installed` the way the fake installer in the tests
   implies.
4. **The field end-to-end run (acceptance 4).** Pack a throwaway plugin, install
   it with `plugin_share install`, see it loaded as a normal plugin, remove it.
5. **The GUI half.** The host routes and the client component are covered by unit
   tests against a fake web server and a fake React; nobody has pressed the
   button in a real window. In particular, whether `git` and `gh` are on the PATH
   of the desktop process.
6. **A dependency that needs a build.** The `pending-builds` approval round-trip
   is tested with a fake installer that reports a pending build; a real
   dependency with install scripts has not been installed.

### Finishing (6.1)

In a DSH session that has `plugin_manager`, paste Prompt A from the README:

```text
Install the DSH plugin "dsh-plugin-share" from this release tarball using the
plugin_manager tool (action: install_bundle, target: the .tgz URL below).
Make sure it appears in list_bundles and that a plugin_share tool becomes
available. If it does not, tell me what is missing instead of installing
anything else.

https://github.com/nezumi0627/dsh-plugin-share/releases/download/v0.1.0/dsh-plugin-share-0.1.0.tgz
```

Then restart DSH, and ask for `plugin_share` with `action: list`. Success is:
the bundle in `list_bundles`, the tool answering, and `plugin_share inspect` of
this repository reporting the digest recorded in its `plugin-share.json`.

### The field test, ready to run (6.2)

Two throwaway plugins are committed under `fixtures/` for exactly this, and both
are already packed:

```text
fixtures/demo-plugin/                        dsh-plugin-share-demo          (no dependencies)
fixtures/demo-plugin-with-dependency/        dsh-plugin-share-demo-dep      (depends on ms ^2.1.3)
```

In a session where `plugin_manager` and `plugin_share` are both available:

```text
1. plugin_share  inspect the absolute path to fixtures/demo-plugin/dist/dsh-plugin-share-demo-0.1.0.tgz
2. plugin_share  install that same path
3. plugin_share  list
4. plugin_share  install the absolute path to fixtures/demo-plugin-with-dependency/dist/dsh-plugin-share-demo-dep-0.1.0.tgz
5. plugin_share  remove dsh-plugin-share-demo
```

What success looks like:

| Step | Evidence |
| --- | --- |
| 1 | `ok: true`, `status: inspected`, the digest of the local file, and a warning that a local file was not checked against a repository manifest |
| 2 | `ok: true`, `status: installed`, the `.tgz` copied under `$DSH_HOME/plugin-share/artifacts/`, a ledger row, and `dsh-plugin-share-demo` in the profile's `dependencies` **and** `dsh.profile.bundles` |
| 3 | the entry listed with `inProfile: true`, `state: installed`; `inProfileNotRecorded` empty |
| 4 | `ms` under the profile's `node_modules`, and the DSH log line `[share-demo-dep] active — ms('2h') is 7200000` |
| 5 | gone from `dsh.profile.bundles`, `list` no longer showing it, DSH still healthy |

A dependency with install scripts (for example `sharp`) should stop at
`status: builds-pending`, naming the packages, with nothing built; re-running the
same install with `approvedBuilds: ["sharp"]` finishes it. That round-trip is what
has not been verified against a real package yet (§6.6).

The GUI step needs a public GitHub repository, so it needs explicit human consent
each time: restart DSH, open the sidebar's **Plugins** page, pick
`dsh-plugin-share-demo`, press **Share**, read the panel (name, version, file
count, size, sha256, repository), choose public or private, and press **Publish**.
Success is a repository with a `v0.1.0` tag, a release carrying the `.tgz`, and a
panel showing the URL that `plugin_share install` accepts.
