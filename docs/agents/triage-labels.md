# Triage Labels

The Matt Pocock skills (`/triage`, `/to-tickets`) and this repo's `/to-epic` speak in terms of five
canonical triage roles. This repo uses one label per role for an issue's state, plus labels for
its kind (`issue-tracker.md` § The shape of the backlog).

| Label             | Axis  | Meaning                                                            |
| ----------------- | ----- | ------------------------------------------------------------------ |
| `needs-triage`    | State | Not ready: needs the maintainer's grill                            |
| `needs-info`      | State | Waiting on the reporter for more information                       |
| `ready-for-agent` | State | Ready for an agent to pick up and implement                        |
| `ready-for-human` | State | Needs judgment, external access, manual testing or a solo session  |
| `wontfix`         | State | Will not be actioned                                               |
| `epic`            | Kind  | A bounded scope over the specs, sliced into tickets                |
| `enhancement`     | Kind  | A request for new behaviour, not yet a spec                        |
| `bug`             | Kind  | Something doesn't work                                             |
| `mutagen`         | Gate  | Upstream Mutagen bug, on the `Mutagen Bugs` milestone              |

Every open issue carries exactly one state label. A ticket carries no kind label: its parent
epic says what it is. When a skill mentions a role (e.g. "apply the AFK-ready triage label"),
use the corresponding label string from this table.

## What triage is for here

Work enters the tracker two ways: the maintainer's pipeline — grill → `/to-epic` (an epic) →
`/to-tickets` (implementation tickets) — and, after release, a user's bug or enhancement. It
never enters through an agent filing a finding (`issue-tracker.md`). Triage takes a bug or an
enhancement: categorize, verify, and grill its decisions live with the maintainer. A verdict of
"real work, worth doing" ends in the grill pipeline or an immediate in-loop fix, not in a
labeled parking state.
