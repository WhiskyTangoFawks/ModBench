# Issue tracker: GitHub

Issues/PRDs live as GitHub issues. Use `gh` for all operations.

## Layering

Durable docs vs. work items:

- **Surface specs** (`docs/specs/<surface>.md`) — present-tense doc per UI surface. Repo-versioned, not tracker.
- **PRDs** — one GitHub issue per initiative (e.g. "Downloads tab v1"), via `/to-spec`; carries `ready-for-agent` (a Milestone can't hold a label). Future tense; spent when slices ship. Not a Milestone: milestones are priority-ordered by title prefix, so minting one per PRD would force a roadmap renumber or brand the initiative speculative — a PRD issue may optionally be *assigned to* a milestone for roadmap grouping, same as any other issue.
- **Implementation issues** — PRD slices, via `/to-tickets` (also works directly on a spec file/section).

On ship: fold outcome into the surface spec — spec always = current behavior.

## Milestones = epics (the roadmap)

[Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) tab = roadmap. Milestone = epic (themed work; assigned issues = slices). Re-purposed: **no release/due-date semantics** — just a goal.

- **One issue → one milestone**, or none. Finer hierarchy (epic→sub-epic): sub-issues/labels, not milestones.
- **Assigning a milestone is how an issue gets prioritized** — a real step of triage, not bookkeeping.
  When the right milestone is obvious, apply it at filing or triage time. Bugs and tech debt don't
  require one — none is a valid state; don't force a fit.
- **Order = title prefix** (no native priority field). Numbered = prioritized/sequenced (`1 — Mod-management maturity`…); unnumbered = speculative, sorts below all numbered.
- Epic narrative = **milestone description**. Unscheduled roadmap items = real issues under the epic, not prose.

Traverse with `gh`:
- **List epics** (numeric prefix order — a plain title sort puts "10" before "2"): `gh api repos/WhiskyTangoFawks/ModBench/milestones --jq 'sort_by(.title | [scan("^[0-9]+")] | if length > 0 then (.[0] | tonumber) else infinite end)[] | "\(.title): \(.open_issues)o/\(.closed_issues)c"'`
- **Epic's issues**: `gh issue list --milestone "1 — Mod-management maturity"`
- **Assign/move**: `gh issue edit <n> --milestone "<title>"`; **create epic**: `gh api --method POST repos/…/milestones -f title=… -f description=…`.

## Conventions

- **Create**: `gh issue create --title "..." --body "..."` (heredoc for multi-line). Body
  contains a code span or backtick-quoted identifier (near-universal for a technical issue)?
  Write it to a file first and pass `--body-file` — an inline `--body "...`code`..."` inside a
  double-quoted shell string lets the shell read the backticks as command substitution and
  silently drops or corrupts everything between them. **Always include a triage-state label from
  `triage-labels.md`'s table** (`--label`, same call or a follow-up `--add-label`) alongside any
  category label (`bug`, `enhancement`, …) — a category label alone leaves the issue outside every
  triage/queue view that reads state (`needs-triage` by default for a freshly-found bug/finding
  with no further judgment already made; `ready-for-human`/`ready-for-agent` if that judgment call
  is already made at filing time, e.g. a design-session ticket).
- **Read**: `gh issue view <number> --json number,title,body,labels,comments` — never
  `--comments`, whose GraphQL query still requests the deprecated `projectCards` field and
  exits 1 in this repo.
- **List**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`; add `--label`/`--state` as needed.
- **Comment**: `gh issue comment <number> --body "..."` — same backtick hazard and same
  `--body-file` fix as Create.
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **`mutagen` label**: any issue whose root cause is (or is suspected to be) in Mutagen itself —
  reported upstream, PR'd upstream, or still being investigated — carries this alongside its
  triage-state and category labels. Lets `gh issue list --label mutagen` answer "what's actually
  Mutagen's problem, not ours" and cross-check against this maintainer's own open upstream
  issues/PRs (`gh issue list --repo Mutagen-Modding/Mutagen --author <user>`) before re-investigating
  something already reported.
- **`needs-ux` label**: alongside its triage-state, pairs with `ready-for-human` (never
  `ready-for-agent`) on any issue whose implementation touches new or changed interactive UI
  (`triage-labels.md`'s UX rules; `/ux-checkpoint` for the protocol). Applied at triage or
  self-applied mid-implementation, and never removed once applied — same permanent-record role as
  `mutagen`. `gh issue list --label needs-ux --label ready-for-human` is the queue to work outside
  orchestration.
- **Blocking links**: dependency is tracker state, not a label or prose. Link the moment a
  dependency is known — at filing, triage, or queue rejection: `gh issue edit <n> --add-blocked-by <m>`
  (`--remove-blocked-by` to undo); read via `--json blockedBy` (nodes carry `state`). Blocked =
  any `OPEN` node; queue tooling (`/orchestrate`) excludes blocked issues automatically and
  readmits them when the blocker closes — no label churn, no re-triage. If `gh`'s installed
  version predates the `--add-blocked-by`/`--remove-blocked-by` flags (added after 2.45.0), use
  the REST endpoint directly instead — version-independent: `gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by --method POST -F issue_id=<numeric id>` (numeric `id`, not the issue number — get it via `gh api repos/<owner>/<repo>/issues/<m> --jq .id`; `-f` sends a string and the endpoint rejects it).
- **A `needs-review` verification failure blocks the review ticket on the bug it found** — required,
  not optional, the moment the bug ticket exists: `gh issue edit <review-ticket> --add-blocked-by <bug-ticket>`
  (or the REST fallback above). This is what lets the next review pass see, without re-deriving it,
  that the ticket isn't ready to re-verify — a comment saying so is not enough; the tracker relation
  is the thing a future pass actually checks. See `triage-labels.md`'s `needs-review` row.
- **Close**: `gh issue close <number> --comment "..."`

`gh` auto-detects repo via `git remote -v`.

## Pull requests as a triage surface

**PRs as request surface: no.** (`yes` if external PRs = feature requests; `/triage` reads this flag.)

If `yes`: same labels/states as issues, via `gh pr`:

- **Read**: `gh pr view <number> --json number,title,body,labels,comments` (same
  deprecated-`projectCards` failure as `gh issue view --comments`); diff: `gh pr diff <number>`.
- **List external PRs**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`; keep `authorAssociation` = `CONTRIBUTOR`/`FIRST_TIME_CONTRIBUTOR`/`NONE`; drop `OWNER`/`MEMBER`/`COLLABORATOR`.
- **Comment/label/close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

Issues/PRs share one number space — bare `#42` may be either; try `gh pr view 42`, fall back `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --json number,title,body,labels,comments`.
