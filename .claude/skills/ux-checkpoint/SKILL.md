---
name: ux-checkpoint
description: Gate before building any new or changed interactive UI (menu entry, tree node, dialog, badge, right-click action) — implement an inert stub, demo it live, get signoff, only then wire logic. Use when starting a `needs-ux` ticket, or mid-implementation the moment a ready-for-agent ticket turns out to need UI shape nobody confirmed.
---

# UX checkpoint

A well-cited, xEdit-sourced shape still gets rejected on sight once the maintainer actually sees
it running. Citations and specs describe UI; they don't demo it. This is the gate:
build the UI, show it live, get a real reaction, *then* wire the logic behind it — so a rejected
shape costs a stub, never a feature.

## What counts as UI that needs this

Any new or changed interactive element: a menu entry, tree node, dialog, badge, right-click
action, or a changed appearance/placement of one that already shipped — a retextured badge
is exactly as unreviewed as a new one. No exemption for a shape that traces straight to xEdit
or an ADR — ADR-0034 tells you what to build, not that anyone has watched it run; the checkpoint
is what closes that gap, not a second design pass.

## What the stub may and may not do

Build the whole interaction surface — menus, dialogs, pickers — and populate it with real data
on read paths (a QuickPick listing actual plugin names, say). A stub demoed against fake data
isn't testing the interaction you're asking to sign off on. What it must not do: mutate
anything. No writes, no state changes, no business logic behind the action — the command handler
it wires to is a no-op until signoff.

## Steps

1. **Work the ticket's usual branch.** Nothing special about branch setup here.
2. **Implement the stub**, within the boundary above.
3. **Commit it.**
4. **Demo it live**, via `/manual-test` — the maintainer needs to see it running, not read about
   it.
5. **Get a live reaction.** If it isn't approval, iterate the stub in the same session — nothing
   downstream has been risked, since no logic exists yet. This loop is the entire point: cheap
   iteration before anything expensive gets built on top.
6. **On approval, the reaction decides what happens next** — ask if it isn't obvious:
   - **"Finish it now"**: continue in this session and wire the logic. No comment needed; nothing
     hands off to anyone who wasn't here.
   - **"Queue it for AFK"**: post a one-line comment on the ticket recording that the stub was
     signed off and is queued (e.g. "Stub signed off live — queued for AFK to finish wiring"),
     flip the label from `ready-for-human` to `ready-for-agent`, and stop. `needs-ux` itself stays
     — a permanent record the ticket went through this, same as `mutagen` marks upstream root
     cause (`docs/agents/issue-tracker.md`).

## Picking up a ticket that already cleared this

A `ready-for-agent` ticket still carrying `needs-ux` has already been through steps 1-6 — its
signoff comment is the confirmation. The committed stub is the confirmed spec: build the logic on
top of it as committed, don't redesign or second-guess the UI it already shows.
