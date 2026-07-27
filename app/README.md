# app/ — Tauri 2 + React shell

Placeholder. Scaffolded in **Phase 7** (docs/PLAN.md §9, §11).

The shell is deliberately thin: it invokes `sundaysync_core::sync()`, renders progress
and the result view, and owns nothing but presentation. Every behaviour worth testing
lives in `crates/core`, which has no Tauri dependency and runs headlessly in CI.

Conventions to reuse from SundayRec when this is built (§1.6, §10):
ffmpeg sidecar bundling + license notices, the i18n pattern (nb + en), and the Tauri
updater setup.
