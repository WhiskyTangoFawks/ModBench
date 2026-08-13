# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| —                          | `not-queue-safe`     | Agent-implementable, but not unattended  |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Human verification is decoupled from implementation by default

**Needing a human to look at the result is not a reason to keep work out of a queue.** The
standard workflow is: build it AFK against the spec, then have a human judge it afterwards and
file what needs changing. Anything a person would answer by *adjusting* the built thing — how a
drag feels, a poll cadence, wording, an icon, spacing — is tuned after it exists, not decided
before it does.

The companion to that is a **paired verification ticket** (`ready-for-human`), listing per
shipped ticket what actually needs eyes. File it when the work is queued, not after — an
unwritten intention to look at something later is how the deferred judgement quietly never
happens. [#313](https://github.com/WhiskyTangoFawks/ModBench/issues/313) is the worked example.

## `not-queue-safe` is local, and it is a modifier

It has no counterpart in the canonical five, so no skill will ask for it by role — apply it by
judgement. It **composes with** a readiness label rather than replacing one: `ready-for-agent` +
`not-queue-safe` means "an agent can do this, but not unattended."

**The test is whether a human's answer can be applied as an adjustment, or whether it invalidates
the build.** Tuning is deferrable and gets no label. Reach for `not-queue-safe` only when getting
it wrong means throwing the implementation away rather than amending it, or when a later slice
cannot start until the answer is known. That is a narrow set, and it should stay narrow — this
label is the exception to the workflow above, not a second opinion about it.

Compare `ready-for-human`, which means an agent cannot do it at all (judgement, external access,
credentials) — a different axis, not a stronger version of this one.

**What this label is not for:** architectural risk. A change that crosses a bounded context,
contradicts an ADR, or alters a wire contract is caught by review, not by a person watching it
being built — and a manual pass cannot see it either. Route those through `/code-review`, and say
so on the ticket.

Scope it in a comment when it applies to only part of a ticket, so the next reader knows which
acceptance criterion earned the label.

Edit the right-hand column to match whatever vocabulary you actually use.
