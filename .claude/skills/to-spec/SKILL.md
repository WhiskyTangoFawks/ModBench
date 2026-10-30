---
name: to-spec
description: Write what the current conversation decided into spec/, or refactor a spec document, and commit it on the maintainer's yes.
disable-model-invocation: true
---

# To spec

Alignment happened in the conversation, and grilling's handoff records it. This skill writes the decisions the handoff lands in `spec/`. A conversation with no handoff gets one first: close it the way grilling does, and have the maintainer confirm it. A decision the change needs and the handoff lacks goes back to the maintainer as a question.

## A refactor

A run that cleans up documents and changes no decision is a refactor, and needs no handoff. Before step 1, read back the documents as they are, as step 3 does. That read-back is the bar: it stands in for the handoff in every step, and each difference goes to the maintainer as a question.

## 1. Draft

Read `spec/CLAUDE.md`, and the CLAUDE.md of each folder you write in: their tests bind every sentence you write. Write in the main checkout. Put each decision where the handoff lands it, in the maintainer's words. Then read every lower document the change touches. Fix each sentence the change makes wrong.

A break from a drain report is code work that needs a sentence changed. Answer it as the Intent section of `spec/CLAUDE.md` says.

Criterion: every decision the handoff lands in `spec/` is written there, and no lower document contradicts it.

## 2. Refactor

One pass for each question, over every sentence the change touches. A pass asks its question and no other:

1. Owned here: does a higher document or another surface hold it? Cite that document and delete the sentence.
2. Intent: apply the Intent section of `spec/CLAUDE.md` and the Strategic intent checks in the standards-docs skill's review checklist.
3. Prose: apply the standards-docs skill.

Criterion: each pass, run again, finds nothing.

## 3. Read back

Dispatch a fresh agent with the changed documents and the documents they cite. Give it nothing from the conversation and nothing from the handoff. Ask it, for each changed section: in one sentence, what must hold and why; each sentence it reads as a tactic; and each sentence that contradicts a document it cites. Then compare its answers with the handoff.

- A read-back that differs from a decision means the draft says something else. Fix the draft and run step 2 again.
- A read-back that still differs after one fix is a decision the handoff lacks. Ask the maintainer.
- A tactic or a contradiction it names: apply the finding when it keeps what was agreed, and ask the maintainer when it changes it.

Each loop dispatches a new agent: a fresh one has read no earlier draft.

Criterion: a fresh read-back states each decision in the handoff, and names no tactic and no contradiction.

## 4. Present

List each changed file with the decision it carries, one line each. The maintainer reads the diff in Source Control. Apply their corrections without another review.

Criterion: the maintainer answers yes to the diff.

## 5. Commit

Stage and commit only this run's files, in one command: `git add -- <paths> && git commit -m "…" -- <paths>`. A staged index left behind blocks an orchestrate merge in the same checkout. Then prompt the handoff's next step, usually `/to-epic`.

Criterion: the commit holds exactly the approved diff, `git status` shows none of this run's files, and the next step is prompted.
