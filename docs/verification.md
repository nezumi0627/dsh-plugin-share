# Verification log

What was actually run, what it showed, and what it did **not** show. Environment:
Windows, Node v24.14.0, pnpm 11.7.0, `gh` authenticated as `nezumi0627`,
`node --test` for every suite.

## 1. The test suite

```text
$ node --test
ℹ tests 150
ℹ pass 150
ℹ fail 0
```

(as of the tree tag `v0.1.3` points at; run `node --test` to reproduce)

Covered: manifest validation for both forms (schema required fields are asserted
to be exactly the ones the validator enforces), tarball read/write round-trips
against the npm format, reading safety (absolute names, `..`, backslashes,
duplicate names, links, directory entries, the inflate bound, the caps),
sha256 digests, source parsing for every input form, redirect and size limits in
the fetcher (the first request included), the store and the ledger, every install
path with a fake installer (digest match, digest mismatch, bare URL without a
digest, manifest/tarball disagreement, a tarball that would not load as a bundle,
build approval round-trip, replacement, refusal, and the artifact a refusal
removes), the `plugin_share` tool's five actions and its `danger-full-access`
refusal, the CLI, the publish planner (including a reproducible pack and the
refusal to pack through a link), and the web host and client halves with a fake
web server and a fake React whose `ctx` refuses an undeclared service the way the
real Client runtime does.

## 2. The release, checked four ways

The digest of the published tarball is recorded in `plugin-share.json` at the
repository root — **not here**. `pack` writes that file and excludes it from the
tarball, so the record lives outside the artifact it describes and can never
disagree with itself. Read the digest from there, then check it four ways:

```text
$ node bin/plugin-share.mjs pack . --owner nezumi0627 --repo dsh-plugin-share \
    --created 2026-10-11T23:58:00+09:00 --exclude .superpowers
packed dsh-plugin-share@0.1.3
sha256 <written into plugin-share.json>
bytes <same file>

$ (Get-FileHash dist\dsh-plugin-share-0.1.3.tgz -Algorithm SHA256).Hash
<plugin-share.json's artifact.sha256>

$ gh release view v0.1.3 --json assets
"digest": "sha256:<the same>"
"size": <artifact.bytes>

$ curl -sL -o curl.tgz https://github.com/nezumi0627/dsh-plugin-share/releases/download/v0.1.3/dsh-plugin-share-0.1.3.tgz
<the same digest, and artifact.bytes bytes>
```

So four independent readings agree: the packer, Windows' own SHA256, GitHub's API
digest, and a fresh download of the release asset.

`--created` is passed explicitly because `pack` otherwise reads it from the
directory's commit date (format.md §1.1), which would make the digest change with
any later commit. The published bytes are the packed files of the tree at tag
`v0.1.3`; the tag itself also records the digest in `plugin-share.json`, which
`pack` excludes, so the tagged tree and the artifact still describe one tree.
`--exclude .superpowers` keeps the agent's working directory out.

The tarball holds 49 entries: every source file plus `package/plugin-share.json`
(the embedded manifest). It contains no `.superpowers/` working directory, no
`dist/`, and no `node_modules`.

The 0.1.0 asset was replaced once, after the installer-result fix (commit
`c6f87b6`): the first build's digest identified bytes that would have reported a
successful profile install as a failure, so it was withdrawn rather than left as
the recommended artifact. 0.1.1 was the review response in §7, 0.1.2 the client-half field fix in §8, and 0.1.3 the owner fallback in §8; the manifest format
is unchanged, so `share` stays `1`.

`git rev-parse v0.1.3` names the commit whose packed files the release carries.

## 3. pnpm accepts the tarball

Run in a throwaway workspace under `%TEMP%`, not in the live profile:

```text
$ node <…>/pnpm.mjs add "file:C:/…/dist/dsh-plugin-share-0.1.3.tgz" --dir %TEMP%\ps-pnpm
Packages: +1
+ dsh-plugin-share 0.1.3
Done in 945ms using pnpm v11.7.0
```

- `package.json` afterwards: `"dsh-plugin-share": "file:C:/…/dist/dsh-plugin-share-0.1.3.tgz"` —
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

Install plugin-share itself, either way round. First check whether it is already
there: the profile lists it in `dsh.profile.bundles`, and the sidebar's Plugins
page shows it under **Installed**. (A Share button cannot exist before this step —
the button is this plugin's own browser half. Verified 2026-10-11: the desktop
profile did not hold the bundle, which is why no button appeared.)

The dialog needs no agent: sidebar **Plugins** → **Add plugin** → the release
tarball URL below → **Install** → **Enable now**.

An agent does it with `plugin_manager`, which is enabled in a Creator-style
preset (the **Cordis** preset):

```text
Install the DSH plugin "dsh-plugin-share" from this release tarball using the
plugin_manager tool (action: install_bundle, target: the .tgz URL below).
Make sure it appears in list_bundles and that a plugin_share tool becomes
available. If it does not, tell me what is missing instead of installing
anything else.

https://github.com/nezumi0627/dsh-plugin-share/releases/download/v0.1.3/dsh-plugin-share-0.1.3.tgz
```

Then restart DSH, and ask for `plugin_share` with `action: list`. Success is:
the bundle in `list_bundles`, the tool answering, the **Share** control on each
bundle's page in **Plugins**, and `plugin_share inspect` of this repository
reporting the digest recorded in its `plugin-share.json`.

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

## 7. The adversarial review, and what it changed

A second agent read this repository read-only and attacked it with its own scripts
before 0.1.1 was cut. It reported ten issues; all ten are fixed in 0.1.1, each with
a test of its own:

| # | What was wrong before the fix | Fix |
| --- | --- | --- |
| 1 | `gunzipSync` had no output bound, so a 1 MB input could ask for gigabytes before a single cap was compared, and every entry read re-inflated the archive | the inflate itself is bounded, and one parse is reused per input |
| 2 | A directory entry (`typeflag 5`) was skipped before its name was checked | every entry is name-checked, directories included |
| 3 | A name with a backslash passed the `/`-based traversal check | a backslash is refused |
| 4 | `artifactFileName()` built an output path from an unvalidated `package.json` name/version | both are validated before anything is written |
| 5 | The panel's digest came from a second pack, so a directory that is not a git repository answered 409 on every honest publish | the plan's `created` value is reused for its publish; `pack` warns when it is not reproducible |
| 6 | `pack` followed a symlink or junction and published its target | links are refused via `lstat` |
| 7 | Two entries with one name could be read as one thing and extracted as another | duplicate entry names are refused |
| 8 | Only redirects were checked for https; a manifest's own `artifact.url` was fetched whatever its scheme | the first request is checked too (`allowInsecure` is for a local test server) |
| 9 | A refused install left the artifact it had just written | that one file is removed |
| 10 | `/publish` accepted a request with no digest, compared the token with `===`, and kept every job forever | the digest is required, the compare is constant time, settled jobs are pruned |

The same review verified these as clean, with its own scripts and transcripts: the
digest is computed before anything is stored or installed and a mismatch leaves no
trace; the installer is never handed a URL; the `danger-full-access` refusal is
fail-closed (20 cases); the Web token is not leaked and answers 403 without it;
store paths cannot be traversed; hostile embedded manifests are refused.

One limit of that review: the environment had no `pnpm`, so what an *extractor*
does with a hostile archive (findings 2, 3 and 7) was inferred from the format
rather than executed. The reader refuses those archives outright, which is what the
tests now pin.

## 8. What the first real install showed

0.1.0 was installed on 2026-10-11 23:34 through the Plugins page's **Add plugin**
dialog (`dsh-plugin-share` landed in the profile's `dependencies` **and**
`dsh.profile.bundles`, and pnpm's log for that operation is kept under
`.plugin-manager/logs/operation-QPQ8f6/`). No Share button appeared on any
package's page.

The cause was in the client half. The Client runtime hands `apply` a *guarded*
`ctx`: reading a service the returned plugin did not declare in `inject` is
**denied**, not `undefined`. `client.js` declared nothing, so its `ctx.slots` read
was refused and the action was never registered — silently, since the button is
what would have reported the problem. The runtime says so in its own words:

```text
service "slots" is not declared by your plugin. Declare it on the plugin you
return: { inject: ['slots', …], apply(ctx) { … } }
```

Every client half that works in that same profile declares its services
(`inject: ['slots']`, `['slots', 'locale']`, …); this one did not. The unit test
had passed because its fake `ctx` was a plain object, far more permissive than the
runtime.

0.1.2 fixes it and makes the test harness refuse an undeclared service exactly as
the runtime does, so the omission now fails in the suite instead of in the browser.

The same install exposed a second problem one step further on, in the publish plan:
the Japanese localization plugin's directory is not a git repository and has no
remote, so the owner fell back to the literal `local` and the panel offered
`https://github.com/local/local-dsh-locale-ja` — a repository `gh repo create` could
never create. 0.1.3 asks `gh api user --jq .login` for the account `gh` is
authenticated as, and only then falls back to `local`, so the planned URL is one
that can exist. A remote still wins over `gh`, and an explicit owner wins over both.
Worth noting for anyone upgrading from 0.1.0: it also predates §7's publish fix, so
publishing from a directory that is not a git repository would have answered 409,
and the client half's `inject` declaration is required before the button exists at
all.
