---
name: to-tickets
description: Break an epic into tracer-bullet tickets, each pointing at the spec lines it makes true and declaring its blocking edges, published to the tracker as sub-issues of the epic.
disable-model-invocation: true
---

# To Tickets

Break an epic into a set of **tickets** — tracer-bullet vertical slices, each pointing at the spec lines it makes true and declaring the tickets that **block** it.

The epic's scope is a list of **pointers** into the specs in `docs/architecture/`. The tickets divide those pointers between them. The specs hold the behaviour, so a ticket carries pointers and never the words they point at.

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-matt-pocock-skills` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (an issue number or URL) as an argument, fetch it and read its full body and comments. Read every spec line the epic's scope points at.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets. A tracer bullet makes a set of the epic's spec lines true, end to end.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Every pointer in the epic's scope lands in exactly one ticket. A slice that needs behaviour no spec line draws has found a gap in the spec: name it to the user, and leave it out.

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

A prefactor or a wide-refactor ticket makes no spec line true. It names its change instead.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **Spec lines**: the pointers it makes true, or the change a prefactor makes

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown, and every pointer in the epic's scope sits in one ticket.

### 5. Publish the tickets to the tracker

Publish one issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real identifiers. Make each one a native sub-issue of the epic and set its blocking edges natively, as `docs/agents/issue-tracker.md` describes. Apply the `ready-for-agent` triage label unless instructed otherwise — the tickets are agent-grabbable by construction.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT close or modify any parent issue.

<issue-template>

## Parent

A reference to the epic.

## Spec lines

- [ ] One pointer per line: file, section, and story or row number.

A prefactor or wide-refactor ticket replaces this section with **Change**: the mechanical change, in one or two sentences.

## Blocked by

- A reference to each blocking ticket, or "None — can start immediately".

</issue-template>

Beyond the spec pointers, avoid file paths and code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.
