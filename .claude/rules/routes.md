---
paths:
  - "src/index.ts"
  - "test/*.test.ts"
---

# Proxied routes

- **A path missing from `ROUTES` fails silently.** It 404s, and the modal treats most non-OK reads
  as "unavailable" and falls back, e.g. `/chains` to its bundled chain table, so nothing errors.
- **Only a test in `test/` that hits the path through the spawned proxy catches a gap.** No test
  enumerates `ROUTES` and many entries have none, so add one for every route you add or rename.
