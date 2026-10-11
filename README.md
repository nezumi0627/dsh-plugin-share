# dsh-plugin-share

Share a DSH plugin by URL.

Handing a plugin to someone used to mean "open Explorer, find the folder, zip it,
tell them where to put it". With plugin-share it is one URL: the plugin's GitHub
repository, or a `.tgz` release asset. The receiver's agent inspects it, sees the
checksum and the dependencies, and installs it into their own profile after
approval — where it behaves like any other DSH plugin.

plugin-share is three things:

| Piece | What it does |
| --- | --- |
| **The format** | [`plugin-share.json`](docs/format.md) plus an npm-format tarball: name, version, author, site, creation date, sha256. |
| **The packer** | `plugin-share pack` writes the tarball, the manifest, and the digest; the CLI also inspects and verifies. |
| **The installer** | a `plugin_share` tool for agents (`inspect`, `install`, `verify`, `list`, `remove`) and a **Share** button on a plugin's detail page in the GUI. |

Installing a shared plugin is *not* a separate mechanism: plugin-share verifies
the tarball against the author's digest and then hands the verified local file to
the profile's own installer. The plugin ends up in `dsh.profile.bundles` and is
loaded normally.

## Install plugin-share itself

There is no Share button until plugin-share is installed — the button is a
contribution of this plugin's browser half, so it cannot exist before the plugin
does. Installing it is one dialog, and it needs no agent and no preset change.

**The dialog (easiest).** In the Web app, open the sidebar's **Plugins** page and
press **Add plugin**. DSH accepts a package name, a Git address, a tarball, or an
absolute local path; paste the release tarball URL:

```text
https://github.com/nezumi0627/dsh-plugin-share/releases/download/v0.1.2/dsh-plugin-share-0.1.2.tgz
```

Then **Install**, and **Enable now** when it finishes. Installing a bundle needs
pnpm and, if the profile's package has install scripts, a second approval the
dialog offers itself.

**Prompt A (agent side).** The same install through the built-in `plugin_manager`
tool, for a session that has one — a Creator-style preset, which is where DSH
enables that tool:

```text
Install the DSH plugin "dsh-plugin-share" from this release tarball using the
plugin_manager tool (action: install_bundle, target: the .tgz URL below).
Make sure it appears in list_bundles and that a plugin_share tool becomes
available. If it does not, tell me what is missing instead of installing
anything else.

https://github.com/nezumi0627/dsh-plugin-share/releases/download/v0.1.2/dsh-plugin-share-0.1.2.tgz
```

If the release asset is unavailable, the same tag installs from git:

```text
... instead of the .tgz URL, use this spec: git+https://github.com/nezumi0627/dsh-plugin-share#v0.1.2
```

`plugin_manager` is disabled by default (`tool-plugin-manager` is `disabled: true`
in the Web app's patch) and the **Cordis** agent preset is what re-enables it as
`@deepseek-ai/dsh-plugin-manager/tools`. If a session has no `plugin_manager` tool,
either start it in that preset or use the dialog above instead — the dialog is the
same host code path, with the profile manager's own UI on top. The agent route also
needs `danger-full-access`, because installing a bundle changes the profile for
every session and the installed Host code then runs in the desktop process.

Two things to know about this one step:

- It is the **only** path that does not go through plugin-share's own
  verification — plugin-share cannot install itself before it exists. The trust
  anchor is the release asset itself: HTTPS from GitHub, at a tag, with the digest
  published next to it.
- The browser half may load as soon as the profile recomposes, and the Share button
  appears on each bundle's page in **Plugins**. If it does not, **restart DSH**;
  a fresh session is also when `plugin_share` joins the agent's tool list.

## Share your own plugin

**Prompt B, author side.** Paste this in the repository of the plugin you want to
give away:

```text
Make the plugin in this repository shareable with plugin-share. Run
`plugin-share pack .` to produce the .tgz, the plugin-share.json manifest, and
the sha256, then publish the tarball as a GitHub Release. Tell me the repository
URL I should hand to the other person, and the sha256, so they can check it.
```

The same request in Japanese:

```text
このリポジトリのプラグインをプラグインシェアの形式で配れるようにして。pack で
.tgz・plugin-share.json・sha256 を作り、GitHub の Release にその .tgz を上げて、
相手に渡すリポジトリURLと sha256 を教えて。
```

From the GUI you do not need the prompt at all: open the plugin's detail page and
press **Share** (see below).

## Install a shared plugin

**Prompt B, receiver side.** Paste this with whatever URL you were given:

```text
Install the plugin at this URL with plugin-share: <URL>
Run inspect first and show me what it is, who published it, the sha256, and its
dependencies. Only install after I say OK.
```

What the agent does, in order: resolve the source → read `plugin-share.json` →
show you the summary, author, digest, and dependencies → download the tarball →
check the digest → check the tarball is really a DSH bundle → store the verified
copy → hand it to the profile installer → record the install in the ledger.

Refusals are specific, and a refusal installs nothing: `sha256-mismatch` (the
bytes are not what the author published), `sha256-required` (a bare tarball URL
was given without a digest), `manifest-mismatch` (the manifest and the tarball
disagree), `not-a-bundle` (the package would not load as a DSH plugin),
`unsupported-share` (a newer format than this build understands).

## CLI

The CLI is for the author's side and for checking things by hand:

```text
plugin-share — pack a DSH plugin, and check a shared one

  plugin-share pack <dir> [--out <dir>] [--owner <github>] [--repo <name>] [--site <url>] [--created <iso>] [--exclude <name>]…
  plugin-share inspect <source> [--expect-sha256 <hex>]
  plugin-share verify <tarball> [--expect-sha256 <hex>]
  plugin-share --help
```

`pack` writes `<dir>/dist/<name>-<version>.tgz`, `<dir>/plugin-share.json`, and
prints the sha256. It prints a warning when `--owner` is missing, because the
manifest must name the GitHub account it will be published under. `--exclude`
repeatedly keeps a top-level entry (a scratch directory the repository itself
ignores, say) out of the tarball.

`inspect` and `verify` exit `0` when all is well, `1` on a mismatch or a refusal,
and `2` on a usage error. Installing and removing are deliberately left to the
`plugin_share` tool, where the permission gate lives — the CLI does not install
into your profile behind your back.

## The Share button

On a plugin's detail page, plugin-share adds a **Share** button for any bundle
that was installed from a local directory (a `link:` or directory `file:` spec in
the profile). Bundles from the registry or from someone else's tarball have no
local source to publish, so no button is shown.

Pressing it opens a confirmation panel with the name, version, file count, total
size, **sha256**, repository, and a public/private choice. Pressing Publish then
creates the GitHub repository (when needed), commits, tags `v<version>`, pushes,
and uploads the tarball as a release asset — using your own `git` and `gh`
credentials, in your own account. The panel then shows the repository URL and the
artifact URL to paste into the receiver's prompt.

Publishing is irreversible: it puts a tag and a release in a public repository by
default. The panel shows this before anything leaves your machine, and the host
refuses a publish that does not carry the explicit confirmation and, when it is
sent, a digest that matches the files as they are right now.

## What plugin-share does not do

- No central catalog, no registry, no index: a shared plugin lives in the
  author's own repository, and you install it from that URL.
- No signing and no identity check. See below.
- No auto-update: `plugin_share verify` re-checks what is installed, but nothing
  fetches a newer version by itself.
- It does not replace DSH's own plugin manager. It wraps it.

## Security, honestly

- **sha256 is not a signature.** It proves the bytes you installed are the bytes
  the author published. It says nothing about who the author is or whether the
  code is safe. Install plugins you have read, or whose author you trust.
- **The author fields are a record, not a proof.** `author.github` is what the
  packer was told; nothing verifies the account. Read the URL you were given.
- **Dependencies come from the npm registry**, and their install scripts can run
  code. plugin-share makes the profile installer ask first: a dependency that
  needs to build surfaces as `pending-builds`, naming the packages, and only runs
  after you approve those names.
- **Installing changes the profile for every session.** That is why the
  `plugin_share` tool requires `danger-full-access`.
- **Do not delete `artifacts/`** under `$DSH_HOME/plugin-share/`. Those are the
  verified copies the profile points at.
- The install ledger is a record of what happened on this machine. What protects
  a later install is the digest check, which is why `verify` re-hashes the stored
  tarball instead of trusting the ledger.

## Status

Version `0.1.2`. The format is `share: 1` and is documented in
[`docs/format.md`](docs/format.md); it is deliberately conservative, and a
breaking change bumps `share` rather than silently changing meaning.

## Working on this repository

See [`AGENTS.md`](AGENTS.md). Tests are `node --test`; there are no runtime
dependencies, and the plugin imports nothing from `@deepseek-ai/*`.
