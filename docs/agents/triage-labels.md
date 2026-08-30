# Triage Labels

The skills speak in terms of five canonical triage roles. This repo uses labels matching those roles, plus one local state label (`needs-review`).

**Every issue carries one of these at creation** (`issue-tracker.md` § Create), alongside any
category label (`bug`, `enhancement`, …) — a category label alone leaves the issue outside every
triage/queue view that reads state. Default to `needs-triage` for a freshly-found bug/finding with
no further judgment already made.

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
- If human verification after the implementation is required, after implementation the ticket is labelled `needs-review` + `ready-for-human` (replacing `ready-for-agent`) and left open — **close = verified**. A failed look files a new bug, not a reopen — and the review ticket is linked `--add-blocked-by` the new bug (`issue-tracker.md` § Blocking links) the moment the bug ticket exists, so a future review pass sees the block instead of re-deriving why the last pass didn't close it.
- If triage uncovers questions that require spike level work with the user-in-the-loop to answer before the ticket can be implemented, ask the user if they want to investigate now during the triage session, or create a blocking "ready-for-human" spike ticket, and give your recommendation.
- **Any UX design decision goes through the maintainer — no exceptions** (maintainer ruling, 2026-08-29, #565). A ticket's AC must never prescribe a specific UI shape or primitive (a new tree node, a particular widget, where something lives) without the maintainer's explicit confirmation of that shape — surfacing the underlying need ("let the user check X") is triage's job; picking the widget is not, unless the maintainer picked it. This applies with extra force when the shape is *inherited* from another ticket's own AC rather than freshly proposed: an AI-generated ticket's assumption about UI shape is not confirmation, no matter how many further tickets cite it as settled — trace an inherited shape back to where the maintainer actually signed off on it, and if that link doesn't exist, the ticket stays in `needs-triage` (flagged for the maintainer) rather than advancing to `ready-for-agent` on the strength of a prior ticket's say-so. A ticket's GitHub `author` being the maintainer's own account is **not** that signal either — agents post under the same account, so it proves nothing about who actually wrote the body; look for an explicit human decision (a quoted maintainer ruling, a comment in their own voice), not the byline. Nor is a ticket being thorough, well-cited (ADR references, xEdit source lines) or internally well-reasoned — agents write tickets like that constantly, and per the maintainer directly (2026-08-29): "I don't read half of what the AI Agent writes." Quality and specificity of the writing is not evidence anyone signed off on it. The only real signal is a decision that actually happened in a live exchange with the maintainer — a direct instruction, an answered question, a comment unambiguously in their own voice making the call — not a well-constructed brief that merely looks decided.
- **A ticket whose AC implies a new or changed interactive UI element carries `needs-ux`** alongside `ready-for-human` (`issue-tracker.md`'s Conventions) — applied at triage the moment that implication is visible, or self-applied mid-implementation the instant a `ready-for-agent` ticket turns out to need UI nobody triaged for (downgrade the state, leave the branch pushed, stop there). `/orchestrate` never sees it: state stays `ready-for-human` until the checkpoint clears it. What counts as UI and what the checkpoint requires: `/ux-checkpoint`.
- **Report UX separately from technical, and lead with it** (maintainer ruling, 2026-08-29, #363/#574). The maintainer is a stakeholder + architect, not a consumer of implementation narrative by default — root cause, hex dumps, and code paths belong in the ticket, not the chat. Any triage/review report to the maintainer leads with a short, plain-language list of UX decisions needed (if any exist), before any technical detail; a new interactive UI element (menu entry, tree node, dialog, badge) is named explicitly as new, never folded silently into a wall of technical justification on the assumption an ADR citation or a prior ticket's framing already settles it.
## What is not a label

- **Model capability.** A large or cross-cutting slice gets a dispatch note in its agent brief
  ("dispatch with a frontier model — Opus/Fable"), never a tracker label (maintainer ruling,
  2026-08-16, reverting a short-lived `needs-strong-model` label). Queues read the brief when
  they pick the issue up; a label would be one more state to keep honest.
