---
status: accepted
---

# One index row per (FormKey, origin, plugin)

The `records` table is keyed `(form_key, origin, plugin)` — a plugin is identified by
`(origin, filename)`, not a bare filename ([ADR-0036](0036-plugin-identity-is-origin-plus-filename.md)).
The same FormKey appears once per plugin copy that contains it — the original definition and
every override. This makes every major operation a direct SQL query:

- **Winning record** — `WHERE form_key = ? AND is_winner = true`
- **Full override stack** — `WHERE form_key = ? ORDER BY load_order_idx`
- **Conflict detection** — `GROUP BY form_key HAVING COUNT(*) > 1`
- **ITM detection** — two rows for the same FormKey with equal `content_hash`
- **Field-level conflicts** — `ConflictClassifier` (ADR-0016) compares the rows' documents
  field by field
