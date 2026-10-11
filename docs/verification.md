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

## 2. The release, checked against the repository

```text
$ node bin/plugin-share.mjs pack . --owner nezumi0627 --repo dsh-plugin-share --exclude .superpowers
packed dsh-plugin-share@0.1.0
sha256 d95b0eab10945a50bba28535de4dcc8e5e37b1d2637ed357314c2a36a29d4953
bytes 82767
excluded .superpowers

$ (Get-FileHash dist\dsh-plugin-share-0.1.0.tgz -Algorithm SHA256).Hash
d95b0eab10945a50bba28535de4dcc8e5e37b1d2637ed357314c2a36a29d4953   # == plugin-share.json's artifact.sha256

$ gh release view v0.1.0 --json assets
"digest": "sha256:d95b0eab10945a50bba28535de4dcc8e5e37b1d2637ed357314c2a36a29d4953"
"size": 82767

$ curl -sL -o curl.tgz https://github.com/nezumi0627/dsh-plugin-share/releases/download/v0.1.0/dsh-plugin-share-0.1.0.tgz
d95b0eab10945a50bba28535de4dcc8e5e37b1d2637ed357314c2a36a29d4953   # 82767 bytes, from the release URL
```

So four independent readings agree: the packer, Windows' own SHA256, GitHub's API
digest, and a fresh download of the release asset.

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

## 4. What is **not** verified yet

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

### Finishing (4.1)

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
this repository reporting the sha256 above.
