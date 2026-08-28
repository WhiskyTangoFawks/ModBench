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
  silently drops or corrupts everything between them.
- **Read**: `gh issue view <number> --json number,title,body,labels,comments` — never
  `--comments`, whose GraphQL query still requests the deprecated `projectCards` field and
  exits 1 in this repo.
- **List**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`; add `--label`/`--state` as needed.
- **Comment**: `gh issue comment <number> --body "..."` — same backtick hazard and same
  `--body-file` fix as Create.
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Blocking links**: dependency is tracker state, not a label or prose. Link the moment a
  dependency is known — at filing, triage, or queue rejection: `gh issue edit <n> --add-blocked-by <m>`
  (`--remove-blocked-by` to undo); read via `--json blockedBy` (nodes carry `state`). Blocked =
  any `OPEN` node; queue tooling (`/orchestrate`) excludes blocked issues automatically and
  readmits them when the blocker closes — no label churn, no re-triage.
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
