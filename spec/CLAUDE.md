# The specification

`spec/` holds the chain of authority that root CLAUDE.md ranks, and GLOSSARY.md. It changes only through `/to-spec`.

## Intent

A sentence earns its place here when it states intent: what must hold, and why. A sentence that another correct implementation would need changed is a tactic. A tactic lives in the code, a test or the commit message. Each folder's CLAUDE.md applies this test to its kind of document.

Write a sentence for a developer who shares the goal, and leave the how to them. Read a sentence the same way: a case it does not name is decided by its intent. A rule a higher document holds is cited, never restated.

When code work needs a sentence here changed, or a story needs an exception to one, the sentence is too tactical. Relax it so the tactic is free, or raise the strategic decision the tactic falls out of. A sentence here never changes to match the code.

## Where a decision lands

- `principles.md`: a rule every decision serves.
- `adr/`: a decision that clears the bar in `adr/CLAUDE.md`.
- `out-of-scope/`: a place Modbench diverges from its reference tool, or omits what it does.
- `architecture/`: a box, a layer, or a reference between boxes.
- `surfaces/`: what a user sees and does. A gesture lands in `surfaces/commands.md`.
- `GLOSSARY.md`: a word of the maintainer's that a model would misread.
- A tactical decision lands in the Notes of the ticket it bears on, as a default the implementer may override with a reason, or nowhere.

## GLOSSARY.md

GLOSSARY.md holds words already in the maintainer's head. Through it, an agent speaks the maintainer's language. An entry records a word the maintainer uses. A word an agent coined stays out. The file's opening says which words earn an entry.

- Two heading levels. `#` is a term. `##` is a kind of the `#` term above it, and its definition starts with that term: a [parent] that [difference]. A term with two parents stays a `#`, and its definition names both.
- The heading is the canonical spelling, so `grep -E '^#+ Term$'` finds it. Where the language allows, a kind's heading contains its parent's name: Mod order, Patch plugin.
- The body is the definition on one line, then a blank line and an optional `Avoid:` line. One or two sentences. Define what it is, not what it does.
- Related terms sit next to each other, and a term is defined before it is used.
- A kind gets its own heading when it has its own `Avoid:` words or facts beyond one clause. A kind that is only a state of its parent stays a sentence in the parent.
- `Avoid:` lists words someone still says. A word with a legitimate use elsewhere is scoped in brackets: `Avoid: patch (a kind of plugin)`.
