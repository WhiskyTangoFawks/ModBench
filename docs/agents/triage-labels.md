# Triage Labels

The skills speak in terms of five canonical triage roles. This repo uses labels matching those roles, plus one local state label (`needs-review`).

| Label                      |Meaning                                  |
| -------------------------- |---------------------------------------- |
| `needs-triage`             | Maintainer needs to evaluate this issue  |
| `needs-info`               | Waiting on reporter for more information |
| `ready-for-agent`          | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | Fully specified, but requires human      |
| `wontfix`                  | Will not be actioned                     |
| `needs-review`             | Built; awaiting human verification       |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Triage goal is a ticket ready for AFK implementation

The standard workflow is: build it AFK against the spec in an implementation ticket. Any requirements for a user in the loop should be decoupled when possible.
- If human verification after the implementation is required, after implementation the ticket is labelled `needs-review` + `ready-for-human` (replacing `ready-for-agent`) and left open — **close = verified**. A failed look files a new bug, not a reopen.
- If triage uncovers questions that require spike level work with the user-in-the-loop to answer before the ticket can be implemented, ask the user if they want to investigate now during the triage session, or create a blocking "ready-for-human" spike ticket, and give your recommendation.