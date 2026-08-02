# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| —                          | `needs-solo-session` | Agent-implementable, but not queue-safe  |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## `needs-solo-session` is local, and it is a modifier

It has no counterpart in the canonical five, so no skill will ask for it by role — apply it by judgement. It **composes with** a readiness label rather than replacing one: `ready-for-agent` + `needs-solo-session` means "an agent can do this, but give it a dedicated session with a developer in the loop, not a slot in an orchestrated queue."

Reach for it when the work is fully specified yet the *right answer needs looking at* — a decision about how something feels, an interaction whose candidate solutions can only be told apart by running them, or a change resting on an assumption that should be checked before the rest is worth building. Compare `ready-for-human`, which means an agent cannot do it at all (judgement, external access, credentials).

Scope it in a comment when it applies to only part of a ticket, so the next reader knows which acceptance criterion earned the label.

Edit the right-hand column to match whatever vocabulary you actually use.
