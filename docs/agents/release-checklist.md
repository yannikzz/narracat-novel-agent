# Release Checklist

> 覆盖 macOS arm64 发布候选。打包分两档：`bun --no-cache run package` = 签名不公证（本机验证档），`bun --no-cache run package:release` = 发版档，公证凭证与语料 token 在第一步就断言，Developer ID 签名身份两档都是第一道闸（见 `scripts/package-rc.mjs`）。真实 provider Agent run 不属于本清单 gate，单独跑。

## RC Identity

- Product name: `NarraCat`
- App ID: `app.narracat.desktop`
- Target: macOS arm64
- Artifact: DMG plus unpacked `.app`
- Artifact naming: `NarraCat-${version}-mac-arm64`
- Client version: `package.json`'s `version`, decided by a human at release time (ADR-0038; superseded the commit-count derivation of ADR-0006). Resolved through `scripts/client-version.mjs`; must be strictly greater than `HIGHEST_SHIPPED_VERSION` or those machines never see the update.

## Step 0 — Decide The Version

**This is now the first step of a release, not a by-product of packaging.** Bump `package.json`'s
`version` (patch for fixes, minor for new capability), commit it, and only then package. Forgetting
this is caught before packaging by `release.mjs`'s duplicate-version gate — but catching it early
saves a signing + notarization round.

After the release ships, raise **both** numbers — they are a pair: `HIGHEST_SHIPPED_VERSION` in
`scripts/client-version.mjs` goes to the version just shipped, and `package.json`'s `version` goes to
the next development version. Raising only the former makes the invariant test fail immediately (the
two are equal right after a release), and relaxing that test to `>=` would remove the "forgot to
bump" protection entirely. Doing both leaves the repo parked at "next version, ready to cut".

Both platforms read the same `package.json`, so mac and Windows artifacts carry the same version
by construction — that is the point of ADR-0038.

## Step 1 — Decide The Platforms (mandatory, no default)

The two platforms are built on separate paths and merged into one Release:

| Platform | Built where | Why only there |
| --- | --- | --- |
| macOS arm64 | this Mac | signing reads the Developer ID cert from the local Keychain, then Apple notarization |
| Windows x64 | GitHub CI | mac cannot cross-build a working Windows package (keytar / better-sqlite3 are mac-native binaries), and SignPath requires a verifiable build from source |

```bash
# 1. Windows artifacts (≈5 min). CI uploads them straight into the v<version> draft release —
#    nothing to download locally. A draft is invisible to releases/latest, so this is not a publish.
gh workflow run windows-release-build.yml --ref main

# 2. Package mac + publish both platforms into that same release
bun --no-cache run release --win-from-release
```

`--win-from-release` verifies remotely that the three Windows assets are actually present and
non-empty before the confirmation prompt. Use `--with-win <dir>` only when the artifacts already
sit on this machine — downloading 244 MB from CI just to upload it back is a pointless round trip
(and at the ~23 KB/s measured from here, a 3-hour one).

`release` **refuses to run without `--with-win <dir>` or `--mac-only`.** Shipping mac-only used to be
the silent default; once Windows became a real distribution target that default turned into a trap —
and a worse one than "one package missing":

**Both platforms' update manifests resolve to `releases/latest`** (see `workers/narracat-update`:
`latest-mac.yml` and `latest.yml` both map to `releases/latest/download/<manifest>`). A release
carrying only one platform's artifacts becomes `latest`, and the *other* platform's manifest lookup
then 404s — that update channel is broken until the next release that includes it. Not "users stay
one version behind": they stop receiving updates entirely, with no error on either end.

**So once both platforms have users, every release must ship both.** `--mac-only` exists for the
current state (Windows never published yet) and for the emergency case where Windows CI cannot
produce a package and a mac hotfix cannot wait.

## Automatic Gate

Before packaging or handing off an RC, run:

```bash
bun --no-cache run verify:narracat-agent-core
node scripts/prepare-narracat-agent-core.mjs --if-missing --optional
bun --no-cache run ops:check
bun --no-cache run test
bun --no-cache run typecheck
bun --no-cache run check:design
bun --no-cache run build
bun --no-cache run package
```

`bun --no-cache run package` reads the client version from `package.json`, verifies and prepares NarraCat Agent Core, probes the staged runtime, builds Electron bundles, packages the macOS arm64 DMG, and smokes the packaged app.

Do not use an upstream NarraCat checkout during RC packaging. RC packaging uses the internal `agent-core/narracat` source and packages it as `NarraCatAgentCore`.

## Packaged App Smoke

Use the unpacked `.app` produced beside the DMG:

1. Launch the unpacked `NarraCat.app`.
2. Open Settings and confirm the client version matches `node scripts/client-version.mjs`.
3. Confirm NarraCat Agent Core diagnostics report the locked Agent Core version.
4. Create a temporary Novel project from Library.
5. Open the created Workbench.
6. Confirm the project contains `.narracat/`, `bible/`, `outline/`, `manuscript/`, `reviews/`, and `notes/`.
7. Confirm the initial template content is visible in Workbench where applicable.

Do not treat this smoke as proof of Agent execution or runtime identity. Run Packaged Agent Runtime Smoke when packaged runtime code changes or before using an RC for Agent validation.

## Packaged Agent Runtime Smoke

Use the unpacked `.app` produced beside the DMG. This smoke validates the bundled runtime, not model quality.

0. Packaging already ran two runtime gates, and the package fails on either. They cover different binaries, so neither substitutes for the other:
   - `probe staged Agent Core runtime` (before the build) runs `scripts/probe-staged-agent-core-runtime.mjs` with the current Node against the staged tree — the engine's own node-ABI `better-sqlite3`. Cross-platform and CI-safe.
   - `smoke packaged app` (after `audit packaged app boundary`, macOS tier only) runs `scripts/smoke-memory.mjs` against this very `.app`, driving the real production path: utility process, the root `node_modules` Electron-ABI `better-sqlite3`, engine core dist, real RPC, and the embedding selftest against the bundled model.

   If either step was skipped, do not treat the artifact as smoke-ready.
1. Launch the unpacked `NarraCat.app` as a packaged app, not through `bun --no-cache run dev`.
2. Open Settings and run the vector health check card; a green result proves the bundled runtime plus the bundled embedding model still work under hardened runtime.
3. Confirm Settings reports the locked NarraCat Agent Core version and path from inside the packaged app (not from the working tree).
4. Open a Novel project and run one Agent command; confirm the per-project NovelMemory utility process starts, serves memory tools, and is reclaimed when the app quits.
5. Confirm logs or process inspection do not show use of user system `node`, shell, `PATH`, nvm, Homebrew, or Terminal.
6. Observe the Dock during the probes: only NarraCat may be visible or active; Terminal.app and extra helper app entries must not jump or appear.
7. After this passes, run a separate real provider Agent smoke if the release needs to validate model execution.
