---
name: to-epic
description: Turn the current conversation into an epic — the bounded scope of one batch of work, drawn as the spec diff it makes true — and publish it to the issue tracker, ready for /to-tickets.
disable-model-invocation: true
---

This skill takes the current conversation and the repo's specs and produces an epic: the scope of one batch of work. The specification on `main` is the target. A `/to-spec` commit changes the target, and its `spec/` diff bounds the work. When the conversation changed the specification, `/to-spec` commits that change first. The epic says which of it this batch makes true, and nothing more. Do NOT interview the user — just synthesize what you already know.

The issue tracker's conventions are in `docs/agents/issue-tracker.md`, and the triage labels in `docs/agents/triage-labels.md`.

## Process

1. Find the work. Each `/to-spec` commit the conversation made is work. Work with no commit, such as a bug or a line drawn but never built, is a spec line on `main`: find it.

   A settled behaviour with neither is a gap in the spec, and the spec is the user's. Name each gap to the user and leave it out of the epic until `/to-spec` draws it.

   Done when every behaviour in scope has its commit or its spec line, or is named to the user as a gap.

2. Draw the scope. A commit the batch takes whole is its SHA. Part of a commit is the SHA with the file and section it takes. A spec line with no commit is a **pointer**: file, section, and story or row numbers. A pointer carries no words from the line it points at; the spec holds the words, and a copy drifts from them. Name the parts of each commit and the spec lines nearby that this batch leaves for later.

   Check the scope with the user.

3. Find the epic the batch joins: list the open epics, `gh issue list --label epic --state open`. When an open epic's goal holds the batch, or the batch is one ticket's worth, it joins that epic (`docs/agents/issue-tracker.md` § The shape of the backlog). Add its scope to that epic's Scope and Out of scope, widen its Goal when the goal grows, and close by prompting `/to-tickets` on it. Otherwise go on to step 4.

   Done when the batch has joined an open epic, or no open epic holds it.

4. Write the epic using the template below, then publish it to the project issue tracker with the epic label and a goal or a lane milestone, as `docs/agents/issue-tracker.md` names them. Close by prompting `/to-tickets` on the new epic.

<epic-template>

## Goal

One or two sentences: what the user can do once this epic ships, from the user's perspective.

## Scope

The commits whose `spec/` diff this epic makes true, then the pointers for work no commit carries. One bullet per commit or file. A caption is never a scope line: it orients, and no epic makes its words true.

<scope-example>

- `cf7f905d7`
- `a1b2c3d4e`: `surfaces/plugins.md` § The tree
- `surfaces/common.md` § States, story 5
- `commands.md`: the `plugin create` and `plugin compile` rows

</scope-example>

## Out of scope

The parts of a commit and the nearby spec lines this epic leaves for later, each with one line saying why.

</epic-template>
