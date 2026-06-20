# Phase 10 — Record Lifecycle Operations

**Status: Not Started**

*Goal: full create / delete / renumber lifecycle for records, with cascading safety checks and atomic rollback.*

---

## Sub-phases

| Phase | Goal | Depends on |
|-------|------|-----------|
| [Phase 11](phase-11.md) | `form_references` table + Referenced By UI | — |
| [Phase 10.1](phase-10.1.md) | PendingChange model (`ChangeType`, `GroupId`) + ChangeGroup infrastructure | — |
| [Phase 10.2](phase-10.2.md) | New record creation (`POST /plugins/{plugin}/records`, replaces copy-to) | 10.1 |
| [Phase 10.3](phase-10.3.md) | Delete records (batch, with cross-plugin safety check) | 11, 10.1 |
| [Phase 10.4](phase-10.4.md) | Renumber FormID (cascading reference updates) | 11, 10.1 |
| [Phase 10.5](phase-10.5.md) | Group save path (atomic multi-plugin write) | 10.1, 10.2, 10.3, 10.4 |

**Recommended order:** Phase 11 → 10.1 → 10.2 → 10.3 → 10.4 → 10.5
