# Changes

## 1.0.0 — 2026-11-14

- TypeScript library with explicit `mode: 'static' | 'updatable'`.
- Application-owned OpenUI execution and a specialized Telegram update client.
- Static mode renders state/expressions without a client or required instance ID.
- Small updatable HTML needs no `clientEntry`; lifecycle components provide one.
- Versioned delta updates, keyed DOM preservation, snapshot/patch/form contracts.
- Node.js 22.15+, 24 and 26 support.
- Safe form dictionaries, preserved lifecycle DOM, delivery checkpoints, native Telegram links and invalidation of restored operation results after program changes.
- Runnable counter and capability-gallery examples, browser and private-chat Telegram delivery, restart and oversized-update recipes.
- Explicit Telegram query permission, resynchronization after rejected delivery and asynchronous client error reporting.
- Client specialization preserves lifecycle context services, diagnoses unsupported HTML and includes reachable or reserved component CSS.
- Compact per-scenario Telegram cards and retries of identical data frames after transient delivery failures, without repeating actions.
- Fresh lifecycle DOM on component type changes/remounts, form validation before native link publication and atomic rejection of updates requiring unreserved component CSS.
