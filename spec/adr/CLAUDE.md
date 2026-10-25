# ADRs

An ADR's title and opening paragraph are the decision and the intent behind it. They are the invariant, and they hold the ADR's authority.

The sections below serve the decision. Consequences show the decision applied to the cases known when it was written. Alternatives rejected show why. Neither is a rule of its own.

- A case that no consequence names is decided by the decision's intent.
- When a consequence works against the decision's intent, the intent wins. Report the break, as root CLAUDE.md says.
- A sentence whose removal leaves the decision unchanged is not the decision. It lives in a lower document, the code or the commit message, never in an ADR.
- Cite an ADR by its number. A line inside it is never a citation.

## When a decision earns an ADR

All three hold: it is hard to reverse, a reader would be surprised by it without the context, and it came from a real trade-off between alternatives.

## Form

- The title is the decision, as the shortest phrase that states it.
- The opening paragraph is one to three sentences: the forces, the decision and why.
- Consequences, when present, are effects a reader holding only the paragraph would get wrong, each with its reason.
- Alternatives rejected, when present, are options a reader would propose, each with why not.
- A new ADR takes the number one past the highest in this folder.
- Revising a decision rewrites the ADR in place. Git holds its history.
