# AGENTS.md — working on dsh-plugin-share

Rules for any agent changing this repository. They exist because this plugin
installs code into other people's DSH profiles and publishes other people's
names to GitHub: the cost of a quiet mistake here is somebody else's machine.

## Hard rules

1. **Zero runtime dependencies.** `package.json` has no `dependencies` and no
   `devDependencies`. The tarball writer, the reader, and the sha256 code are all
   in this repository on purpose: `pack` must produce the same bytes on any
   machine, and an install path must not need a network fetch of its own tools to
   verify what it downloaded.
2. **Never import `@deepseek-ai/*`.** These plugins run inside DSH and are loaded
   by it; importing its internals breaks on any DSH update. Talk to the host only
   through the context services that are documented for plugins
   (`tools`, `webServer`, `pluginManager`, `logger`, `effect`, `inject`).
3. **Product code never shells out to `pnpm` or `dsh`.** Installing a bundle goes
   through `pluginManager.installBundle()`; that is the supported seam and it is
   what keeps rollback, peer checks, and build approval working. The exceptions are
   `git`/`gh` in the publish path, which are the author's own tools, and
   [`test/e2e-pnpm.test.mjs`](test/e2e-pnpm.test.mjs), which stands in for the
   profile's package manager to prove that pnpm accepts the spec this plugin
   builds. Nothing under `lib/`, `bin/`, `index.js` or `client.js` may start a
   package manager, and no test may install a bundle any other way.
4. **Node 22 or newer, ESM only.** No CommonJS `require` in `lib/`, `bin/`,
   `index.js`. (`client.js` is the exception: it is a plain browser script loaded
   by the Web module loader, and its `require('react')` comes from that loader.)
5. **Tests are `node --test`.** Every module in `lib/` has a `test/*.test.mjs`.
   Run the whole suite before every commit. New behavior starts as a failing test.
6. **Do not delete or rewrite `artifacts/`.** Those files are the verified
   tarballs a profile points at. Nothing in this repository may clean them up
   automatically.
7. **Writes stay inside `$DSH_HOME/plugin-share/`** (the store and the ledger) or
   inside the author's own plugin repository (the publish path). Never write into
   `node_modules`, a profile's `package.json`, or a stranger's repository.

## Changing the format

The manifest format is a public interface: other people's repositories will carry
`plugin-share.json` files this code did not write.

- The schema, the validator, and the prose must move together:
  [`schema/plugin-share.schema.json`](schema/plugin-share.schema.json),
  [`lib/manifest.js`](lib/manifest.js), [`docs/format.md`](docs/format.md), and
  [`test/manifest.test.mjs`](test/manifest.test.mjs) (which asserts that the
  schema's required fields are exactly the ones the validator enforces).
- A breaking change bumps `share`. Readers refuse a version they do not know
  (`unsupported-share`) instead of guessing.
- Adding an optional field is not a break. Removing one, renaming one, changing
  its meaning, or changing what the digest covers *is*: bump `share` and document
  both versions.
- The same applies to the ledger: it is written as
  `{ "share": 1, "installs": [...] }` and read tolerantly, so an unreadable
  ledger degrades to "no records" rather than a crash.

## Things that are security-relevant, not style

- The digest check happens **before** anything is stored or installed, and a
  mismatch must leave no trace: no store entry, no ledger row, no profile change.
- Verification never passes a URL to the installer. Only the verified local
  `.tgz` path is handed over, so the installer cannot fetch different bytes.
- `install` and `remove` in the tool require `danger-full-access`; that refusal is
  fail-closed and must stay that way.
- Publishing is irreversible and public by default, and must never happen without
  the explicit confirmation from the panel (plus a digest match when one is sent).
- Reading a tarball must refuse absolute entry names, `..` escapes, and link
  entries, and enforce the caps in `lib/tgz-read.js`.

## Conventions

- Commits are one task each, in the imperative: `feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`. Tests pass at every commit.
- Code and comments are English; the README is English with the author-side prompt
  also given in Japanese, because its audience reads both.
- Comments explain *why* (a constraint, a hazard), not what the next line does.
- Report uncertainty instead of guessing: if something was only verified by a
  unit test with a fake host, say so in the pull request or commit message.

## Layout

```text
index.js            host entry: registers the plugin_share tool and the Web routes
client.js           the Share button (plain browser script, no build step)
cordis.patch.yml    the bundle patch DSH inserts
bin/plugin-share.mjs  the CLI (pack, inspect, verify)
lib/                format, pack, tgz read/write, sha256, source parsing, fetch,
                    store, install, tool, publish, webui
schema/             the manifest JSON Schema, both forms
test/               node --test suites, one per module, plus the pnpm end-to-end
fixtures/           two throwaway plugins for the field test (docs/verification.md §6.2)
docs/format.md      the normative format document
docs/superpowers/   the design and plan this was built from
```
