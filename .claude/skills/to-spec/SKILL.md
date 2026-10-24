---
name: to-spec
description: Write what the current conversation decided into spec/, review it, and commit it on the maintainer's yes.
disable-model-invocation: true
---

# To spec

Alignment happened in the conversation, and grilling's handoff records it. This skill writes the decisions the handoff lands in `spec/`. A conversation with no handoff gets one first: close it the way grilling does, and have the maintainer confirm it. A decision the change needs and the handoff lacks goes back to the maintainer as a question.

## 1. Write

Read `spec/CLAUDE.md`, and the CLAUDE.md of each folder you write in: their tests bind every sentence you write. Write in the main checkout. Put each decision where the handoff lands it, in the maintainer's words. Then read every lower document the change touches. Fix each sentence the change makes wrong.

A break from a drain report is code work that needs a sentence changed. Answer it as the Intent section of `spec/CLAUDE.md` says.

Criterion: every decision the handoff lands in `spec/` is written there, and no lower document contradicts it.

## 2. Review

Call the Skill tool with "code-review" on the uncommitted change: `git diff HEAD` and each new file `git status --short` lists. Paste the handoff's `spec/` decisions as its spec, since the reviewer cannot see the conversation. Apply each finding that keeps what was agreed. Bring each finding that changes what was agreed to the maintainer as a question.

Criterion: every finding is applied or asked.

## 3. Present

List each changed file with the decision it carries, one line each. The maintainer reads the diff in Source Control. Apply their corrections without another review.

Criterion: the maintainer answers yes to the diff.

## 4. Commit

Stage and commit only this run's files, in one command: `git add -- <paths> && git commit -m "…" -- <paths>`. A staged index left behind blocks an orchestrate merge in the same checkout. Then prompt the handoff's next step, usually `/to-epic`.

Criterion: the commit holds exactly the approved diff, `git status` shows none of this run's files, and the next step is prompted.
