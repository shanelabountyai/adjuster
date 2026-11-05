# BACKLOG

Unscheduled foundation items. None is in a milestone; pull one in when a clone needs it.

| Id | Item | Why it is not built yet |
|---|---|---|
| F-01 | Audit-log viewer (`audit.read` permission) | The audit rows are written (INV-13 family); no clone has asked to read them in-app yet. |
| F-02 | `/o/[org]/settings/security` page (sessions list, TOTP manage) | Sign-out-everywhere and TOTP exist as flows (INV-05, INV-24–26); a settings page is UI only. |
| ~~F-05~~ | **Done 2026-11-04, v1.5.0.** `vitest` 2.x → 5 (dev-only advisories: tinypool prototype-pollution RCE, critical; vite path traversal, high; 11 moderate) | Found 2026-11-04 during v1.4.1. Dev dependency, never shipped, and `npm audit --omit=dev` is 0. The fix is a semver-major test-runner bump that every clone would have to follow, so it needs its own minor release, not a `security:` patch. |
