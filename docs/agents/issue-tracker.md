# Issue tracker: GitHub

Issues live as GitHub issues. Use `gh` for all operations.

## The shape of the backlog

Four kinds of open issue, nothing else:

- **Epic** (`epic` label) — the bounded scope of one batch of work, drawn as pointers
  into the specs, minted only by the maintainer's grill → `/to-epic` pipeline. Always
  assigned to a release milestone. Future tense; spent when its slices ship. The specs
  it points at are written before its slices are built, never updated afterwards to
  match them.
- **Implementation ticket** — a slice of an epic, minted by `/to-tickets` run against
  that epic; a native sub-issue of it, pointing at the spec lines it makes true, with
  native blocked-by edges. No parentless implementation tickets.
- **Enhancement** (`enhancement` label) — a request for new behaviour that no spec
  draws yet, from the maintainer or a user. A grill turns it into spec and then an
  epic, or it closes. It carries no tickets.
- **Bug** (`bug` label) — something doesn't work, reported by the maintainer or a
  user. Triage verifies it; the fix is an in-loop fix or an epic.

Every open issue carries one state label (`triage-labels.md`).

**Agents never create issues outside `/to-epic` and `/to-tickets` — the tracker
holds no agent-filed findings.** A finding met mid-task is fixed in the same session,
reported to the maintainer in the session summary, or dropped. Only the maintainer
escalates a finding into tracked work, through grill → `/to-epic` → `/to-tickets`.

## Milestones = releases

Exactly four: `1 — Alpha`, `2 — v1`, `3 — v2` — releases, priority-ordered by
numeric title prefix — and `Mutagen Bugs`, the unnumbered parking lot for upstream
Mutagen defects (paired with the `mutagen` label). Assigning a milestone schedules
an issue for that release. Every open issue carries a milestone except one
that needs triage, which may be unscheduled.

Traverse with `gh`:

- **List**: `gh api repos/WhiskyTangoFawks/ModBench/milestones --jq '.[] | "\(.title): \(.open_issues)o/\(.closed_issues)c"'`
- **A release's issues**: `gh issue list --milestone "1 — Alpha"`
- **Assign/move**: `gh issue edit <n> --milestone "<title>"`

## Conventions

- **Create**: `gh issue create --title "..." --body "..."` (heredoc for multi-line). Body
  contains a code span or backtick-quoted identifier (near-universal for a technical issue)?
  Write it to a file first and pass `--body-file` — an inline `--body "...`code`..."` inside a
  double-quoted shell string lets the shell read the backticks as command substitution and
  silently drops or corrupts everything between them.
- **Read**: `gh issue view <number> --json number,title,body,labels,comments` — never
  `--comments`, whose GraphQL query still requests the deprecated `projectCards` field and
  exits 1 in this repo.
- **List**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`; add `--label`/`--state` as needed.
- **Comment**: `gh issue comment <number> --body "..."` — same backtick hazard and same
  `--body-file` fix as Create.
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`. Label
  strings and roles: `triage-labels.md`.
- **`mutagen` label**: any issue whose root cause is (or is suspected to be) in Mutagen itself —
  reported upstream, PR'd upstream, or still being investigated — carries this and sits on the
  `Mutagen Bugs` milestone. Lets `gh issue list --label mutagen` answer "what's actually
  Mutagen's problem, not ours" and cross-check against this maintainer's own open upstream
  issues/PRs (`gh issue list --repo Mutagen-Modding/Mutagen --author <user>`) before
  re-investigating something already reported.
- **Blocking links**: dependency is tracker state, not a label or prose. A ticket body's
  "Blocked by" section is a human-readable mirror of the native edges, never the source of
  truth — an edge that exists only in prose is not set. `/to-tickets` publishes tickets in
  dependency order (blockers first, so every number exists), then sets every edge natively
  in the same run and reads them back to verify. Link the moment a dependency is known:
  `gh issue edit <n> --add-blocked-by <m>`
  (`--remove-blocked-by` to undo); read via `--json blockedBy` (nodes carry `state`). Blocked =
  any `OPEN` node. If `gh`'s installed version predates the `--add-blocked-by`/`--remove-blocked-by`
  flags (added after 2.45.0), use the REST endpoint directly instead — version-independent:
  `gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by --method POST -F issue_id=<numeric id>`
  (numeric `id`, not the issue number — get it via `gh api repos/<owner>/<repo>/issues/<m> --jq .id`;
  `-f` sends a string and the endpoint rejects it).
- **Close**: `gh issue close <number> --comment "..."`

`gh` auto-detects repo via `git remote -v`.

## Pull requests as a triage surface

**PRs as request surface: no.** (`yes` if external PRs = feature requests; `/triage` reads this flag.)

If `yes`: same labels/states as issues, via `gh pr`:

- **Read**: `gh pr view <number> --json number,title,body,labels,comments` (same
  deprecated-`projectCards` failure as `gh issue view --comments`); diff: `gh pr diff <number>`.
- **List external PRs**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`; keep `authorAssociation` = `CONTRIBUTOR`/`FIRST_TIME_CONTRIBUTOR`/`NONE`; drop `OWNER`/`MEMBER`/`COLLABORATOR`.
- **Comment/label/close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

Issues/PRs share one number space — a bare number may be either; try `gh pr view <n>`, fall back `gh issue view <n>`.

## When a skill says "publish to the issue tracker"

Only `/to-epic` (an epic) and `/to-tickets` (implementation tickets) publish — both run
by the maintainer. Any other skill's instruction to file an issue is overridden by
this repo's no-standing-backlog policy above: report the finding to the maintainer
instead.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --json number,title,body,labels,comments`.
