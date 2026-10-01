---
name: to-epic
description: Turn the current conversation into an epic — the bounded scope of one batch of work, drawn as pointers into the repo's specs — and publish it to the issue tracker, ready for /to-tickets.
disable-model-invocation: true
---

This skill takes the current conversation and the repo's specs and produces an epic: the scope of one batch of work. The specs in `docs/architecture/` hold the behaviour. The epic says which of it this batch makes true, and nothing more. Do NOT interview the user — just synthesize what you already know.

The issue tracker's conventions are in `docs/agents/issue-tracker.md`, and the triage labels in `docs/agents/triage-labels.md`.

## Process

1. Read the specs the conversation touched: the surfaces and the `commands.md` rows. For each behaviour the conversation settled, find the spec line that draws it.

   A settled behaviour with no spec line is a gap in the spec, and the spec is the user's. Name each gap to the user and leave it out of the epic until the spec draws it.

   Done when every behaviour in scope has its spec line, or is named to the user as a gap.

2. Draw the scope as **pointers**: file, section, and story or row numbers. A pointer carries no words from the line it points at; the spec holds the words, and a copy drifts from them. Name the spec lines nearby that this batch leaves for later.

   Check the scope with the user.

3. Write the epic using the template below, then publish it to the project issue tracker with the epic label and a release milestone, as `docs/agents/issue-tracker.md` names them.

<epic-template>

## Goal

One or two sentences: what the user can do once this epic ships, from the user's perspective.

## Scope

The spec lines this epic makes true, as pointers. One bullet per file.

<scope-example>

- `surfaces/plugins.md` § The tree, stories 1–9; § A row, stories 10–17
- `surfaces/common.md` § States, story 5
- `commands.md`: the `plugin create` and `plugin compile` rows
</scope-example>

## Out of scope

The nearby spec lines this epic leaves for later, as pointers, each with one line saying why.

</epic-template>
