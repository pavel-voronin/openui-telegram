# Changes

## Unreleased

- Publication dry runs also work after the current version is already on npm.

## 1.0.0 — 2026-11-14

- TypeScript library with explicit `mode: 'static' | 'updatable'`.
- Application-owned OpenUI execution and a specialized Telegram update client.
- Static mode renders state/expressions without a client or required instance ID.
- Small updatable HTML needs no `clientEntry`; lifecycle components provide one.
- Versioned delta updates, keyed DOM preservation, snapshot/patch/form contracts.
- Clean builds, package-consumer verification and CI with coverage gates.
- Node.js 22.15+, 24 and 26 support, checked on Linux and Windows.
- Weekly CI checks against the latest supported Node.js releases.
- Safe form dictionaries, preserved lifecycle DOM, delivery checkpoints, native Telegram links and invalidation of restored operation results after program changes.
- Runnable counter and capability-gallery examples, browser and private-chat Telegram delivery, restart and oversized-update recipes.
- Explicit Telegram query permission, resynchronization after rejected delivery and asynchronous client error reporting.
- Conservative arguments-based callback analysis, unsupported-element diagnostics, reachable/reserved component CSS and polling acknowledgements after completed handlers.
- Telegram demo polling reconnects after temporary network failures without advancing its acknowledgement offset.
- Compact per-scenario Telegram cards and retries of identical data frames after transient delivery failures, without repeating actions.
- Fresh lifecycle DOM on component type changes/remounts, form validation before native link publication and atomic rejection of updates requiring unreserved component CSS.
- npm trusted-publishing workflow for matching stable version tags after all CI checks, with manual dry-run verification.

No release or npm publication is performed by the repository checks.
