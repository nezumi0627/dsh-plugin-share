# Single Repository Plugin Catalog

## Intent

Let the author publish every shareable local DSH plugin to one manually-created GitHub repository. The repository is a browsable catalog, while each plugin remains an independently versioned GitHub Release with its own `.tgz` and checksum.

## Goals

- Connect GitHub and enter one repository URL once; all plugin Share buttons reuse it.
- Give each plugin a collision-free release tag and release asset in the shared repository.
- Keep a root catalog index readable and current as plugins are shared or updated.
- Copy friend instructions containing the individual plugin's release URL and SHA-256, so the recipient can inspect and install only that plugin.
- Preserve the existing secret scan, idempotent repeat behavior, changed-content release update behavior, and digest-bound Publish confirmation.

## Non-goals

- Create a GitHub repository automatically; the author creates one empty repository and supplies its URL.
- Include `dhs-remote` or anything from its repository/package.
- Publish all plugins without the per-plugin confirmation panel and digest it displays.
- Change the receiver's verification-before-install behavior.

## Design

Store a single validated repository target in the plugin-share store. For compatibility, read an older per-package mapping only when all saved targets resolve to the same GitHub repository; ambiguous older mappings require setup again. The catalog is a new repository, `nezumi0627/dsh-plugin-catalog`, kept separate from the `dsh-plugin-share` source repository. Every plugin publishes a namespaced tag derived from its normalized package name and version, preventing collisions such as multiple packages at `v1.0.0`.

Keep each plugin's source snapshot and `plugin-share.json` at the root of its tag so the existing release-manifest installer remains compatible. The default branch contains a generated `README.md` catalog and machine-readable `catalog.json`; updates preserve other plugins' entries and replace only the current plugin entry. Releases carry uniquely named `.tgz` assets and checksums. The copied friend message points to the release-specific repository/tag URL and provides the tarball URL and digest for `plugin_share inspect` followed by user-approved install.

Publishing remains gated by a per-plugin panel confirmation and the exact SHA-256 shown there. Merely pressing Share or saving the repository must never start a GitHub write. No GitHub write is made before that digest is rechecked. Secret scanning runs before planning and again before GitHub writes. Private repository status is shown because recipients need access.

## Open implementation choices

- The catalog is generated from verified release metadata and sorted by package name.
- Existing tags are updated only through the already-supported same-version release update path; different plugins never share a tag.
- Existing standalone CLI publication behavior remains unchanged.
- The user asked to share all eligible plugins, but each remains a separate review-and-publish action so its exact digest is visible and confirmed.

## Acceptance

- Saving one repository makes it available to every installed local plugin.
- Two plugins with the same version publish to distinct tags in one repository.
- Publishing another plugin preserves prior catalog entries; re-sharing one plugin updates only its catalog entry.
- Unchanged content makes no GitHub writes and returns the same share details.
- A digest mismatch, a secret finding, missing repository permission, or missing confirmation blocks all writes.
- Friend instructions identify the selected plugin's release and checksum rather than merely the repository root.
