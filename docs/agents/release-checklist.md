# Release Checklist

> 覆盖 macOS arm64 发布候选。打包分两档：`bun --no-cache run package` = 签名不公证（本机验证档），`bun --no-cache run package:release` = 发版档，公证凭证与语料 token 在第一步就断言，Developer ID 签名身份两档都是第一道闸（见 `scripts/package-rc.mjs`）。真实 provider Agent run 不属于本清单 gate，单独跑。

## RC Identity

- Product name: `NarraCat`
- App ID: `app.narracat.desktop`
- Target: macOS arm64
- Artifact: DMG plus unpacked `.app`
- Artifact naming: `NarraCat-${version}-mac-arm64`
- Client build version: `0.2.<release commit count>` from `scripts/client-build-version.mjs` (line prefix = `CLIENT_BUILD_VERSION_PREFIX`; raised `0.1` → `0.2` on 2026-08-25, see ADR-0006 amendment — a `0.1.x` cut would rank below the shipped `v0.1.1930` and reach nobody)

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

`bun --no-cache run package` computes the client build version from the current release commit, verifies and prepares NarraCat Agent Core, probes the staged runtime, builds Electron bundles, packages the macOS arm64 DMG, and smokes the packaged app.

Do not use an upstream NarraCat checkout during RC packaging. RC packaging uses the internal `agent-core/narracat` source and packages it as `NarraCatAgentCore`.

## Packaged App Smoke

Use the unpacked `.app` produced beside the DMG:

1. Launch the unpacked `NarraCat.app`.
2. Open Settings and confirm the client version matches `node scripts/client-build-version.mjs`.
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
