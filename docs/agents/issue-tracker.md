# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Layering

This repo separates durable documentation from work items:

- **Surface specs** (`docs/specs/<surface>.md`) — living, present-tense documentation of each Modbench UI surface (Mods, mEdit, Downloads, …). Versioned in the repo, not the tracker.
- **PRDs** — one GitHub Milestone per initiative (e.g. "Downloads tab v1"), created via `/to-prd`. Written in future tense; spent once its slices ship.
- **Implementation issues** — vertical slices of a PRD, created via `/to-issues`. `/to-issues` may also be pointed directly at a spec file or section path.

When an initiative's slices ship, fold the outcome back into the relevant surface spec in `docs/specs/` — the spec must always describe current behavior.

## Milestones = epics (the roadmap)

The [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) tab is the roadmap. A milestone is used as an epic: a themed body of work whose assigned issues are its slices. This is a deliberate re-purposing — milestones here carry **no release/commitment semantics and no due dates**; a milestone is just a goal.

- **One issue → one milestone.** An issue belongs to at most one milestone (or none). Any finer hierarchy (epic → sub-epic) uses sub-issues or labels, not milestones.
- **Ordering lives in the title prefix** (GitHub has no priority field). A **number = prioritized/sequenced** (`1 — Mod-management maturity` … `6 — …`); **no number = unprioritized/speculative** (bare topic name, e.g. `Navmesh editing`), which sorts below every numbered epic.
- The per-epic narrative lives in the **milestone description**; un-scheduled roadmap items are tracked as real issues under their epic, not as prose.

Traverse it with `gh`:
- **List epics in order**: `gh api repos/WhiskyTangoFawks/ModBench/milestones --jq 'sort_by(.title)[] | "\(.title): \(.open_issues)o/\(.closed_issues)c"'`
- **Issues in an epic**: `gh issue list --milestone "1 — Mod-management maturity"`
- **Assign / move**: `gh issue edit <n> --milestone "<title>"`; **create an epic**: `gh api --method POST repos/…/milestones -f title=… -f description=…`.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
