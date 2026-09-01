# Triage Labels

The Matt Pocock skills (`/triage`, `/to-spec`, `/to-tickets`) speak in terms of five
canonical triage roles. This repo uses labels matching those roles, plus local labels
for the backlog structure (`issue-tracker.md` § The shape of the backlog).

| Label             | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `needs-triage`    | Maintainer needs to evaluate this issue                        |
| `needs-info`      | Waiting on reporter for more information                       |
| `ready-for-agent` | Fully specified, ready for an AFK agent                        |
| `ready-for-human` | Fully specified, but requires human execution                  |
| `wontfix`         | Will not be actioned                                           |
| `prd`             | Full spec, minted by grill → `/to-spec`; milestone-assigned    |
| `speculative`     | Proto-PRD parked in the 2026-09 migration; grill or discard    |
| `needs-review`    | Legacy: built, awaiting verification — no new issues get this  |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding label string from this table.

## What triage is for here

Work enters the tracker through the maintainer's pipeline — grill → `/to-spec`
(a PRD) → `/to-tickets` (implementation tickets) — never through an agent filing a
finding (`issue-tracker.md`). Triage therefore handles the exceptions: an
externally reported issue, a maintainer note filed raw, a grandfathered legacy
ticket. Its verdicts are the same as ever — categorize, verify, grill decisions
live with the maintainer — but a verdict of "real work, worth doing" ends in the
grill pipeline or an immediate in-loop fix, not in a labeled parking state.
