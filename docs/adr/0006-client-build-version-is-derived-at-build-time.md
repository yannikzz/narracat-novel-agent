# ADR 0006: Client Build Version Is Derived At Build Time

## Status

Superseded by [ADR-0038](0038-client-version-is-declared-not-derived.md) (2026-08-30)

> 派生机制已停用。版本号现由人在 `package.json.version` 声明，理由见 ADR-0038：把版本号绑在
> 「当前分支的历史有多长」上，跨分支不稳定、squash 会让它回落、历史重写会重置（本 ADR 的
> Amendment 就是一次打补丁），且 Windows 成为第二个分发平台后两平台无法同号——已实际造成
> 一台真机永久收不到更新。本文保留作决策史。

## Context

The previous OPS rule required `package.json.version` to equal `0.1.<git commit count>`. That is self-referential because changing `package.json` creates a new commit, which changes the commit count and immediately makes the committed version stale.

## Decision

The user-facing client build version is `<line prefix>.<release commit count>`, but it is derived by the build / release path from the current release commit instead of being hand-maintained in `package.json.version`. `package.json.version` is treated as the package manifest or product-line base version, while About, RC artifact naming, and release verification use the derived client build version.

## Consequences

OPS checks should verify that the version resolver exists and produces the current commit-derived client build version, not that `package.json.version` equals the current commit count. This avoids version drift across normal commits, merge commits, rebases, and release-prep fixes.

## Amendment 2026-08-25: version line raised `0.1` → `0.2`

The prefix lives in a single place, `CLIENT_BUILD_VERSION_PREFIX` in `scripts/client-build-version.mjs`. It was raised from `0.1` to `0.2` on 2026-08-25. The derivation mechanism above is unchanged; only the line moved.

**Why.** This repository was re-created with a clean history on 2026-08-04, so its commit count restarts at 0. The last shipped release, `v0.1.1930`, carries a commit count from the *previous* repository. Both counts landed on the same `0.1.x` line, so a release cut here would be `0.1.63` — which semver ranks *below* the `0.1.1930` already installed on users' machines. `electron-updater` only updates when the feed version is higher, so such a release would reach nobody.

The open-source prep note judged that "the first version number will get smaller, which is expected — monotonic within the repo is enough". That holds for internal builds; **it missed existing users' auto-update path**. This amendment closes that gap.

**Why raise the minor instead of adding an offset to the count.** Under semver every `0.2.x` outranks every `0.1.x`, so the problem is settled once and does not require knowing how far the old line counted. An offset would mean carrying that magic number forever.

**Guard.** `scripts/client-build-version.test.mjs` asserts that the produced version outranks `0.1.1930` even at a commit count of 1, and that the invariant would fail if the prefix were moved back to `0.1`. Validators must use the exported `CLIENT_BUILD_VERSION_RE` rather than hardcoding the prefix in a regex.
