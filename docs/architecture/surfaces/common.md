# Common: what every surface shares

Each surface spec holds what is particular to its view and points here for the rest. This file
grows as the surface specs are written; today it holds what Downloads needs. The gestures, their
Where and their Arguments are in [commands.md](../commands.md), with the Chrome rules for a view's
title bar.

Each story cites its source. A story with no source is owned here.

## A view

As a user, I want:

1. Every list to be a native VS Code tree view, so selection, keyboard navigation, drag and the
   context menu behave as they do everywhere else in VS Code. *ADR-0017, invariant 3*
2. Every view to show the instance value and to follow it: a change on disk, from Modbench, MO2 or
   any other tool, shows up with no action of mine. A view has no refresh of its own. *ADR-0015,
   invariant 2; commands.md, No lifecycle gestures and the one `refresh`*
3. A row's icon to carry its status. The description repeats the status only when it is not the
   default, so an unmarked row reads as the ordinary case.
4. View state (a sort, a toggle) to reset when the extension activates. It is a lens, not a
   setting.
5. Keys and mouse on a tree to do what VS Code's own trees do, as in the Explorer: Space toggles a
   check box, Delete destroys, F2 renames, Ctrl+C copies, Ctrl+Alt+F and F3 find. A key acts only
   while the tree has focus and no input box does, as VS Code's list keys do. The keys of a
   template, xEdit or MO2, are not adopted. *ADR-0018, invariant 1; ruling*
6. Every tree to let me select several rows, and a gesture to act on the whole selection unless it
   only makes sense for one row, which its Argument in the catalog says. *ruling*
7. Every list to reverse its order from its title bar. The direction never changes what the order
   means, such as which item wins. *ruling; CONTEXT.md, Sort direction*

## The name filter

One filter on every list (commands.md, One filter). As a user, I want:

1. To open it from the title bar's first slot, or with Ctrl+F while the view has focus. *Chrome;
   catalog*
2. Typing to narrow the list live, by case-insensitive substring of the row's label.
3. The filter to stay when the input box closes by any route: Enter, Esc, a click on a row or
   elsewhere. Reopening the box shows the term, to edit.
4. To clear it only on purpose: the first slot becomes a clear icon (`$(clear-all)`) while a filter
   is active, and emptying the term also clears it. *Chrome*
5. The view's description to show the active term. *commands.md, One filter*
6. A filter that matches nothing to say so, naming the term, rather than show an empty view.
7. The filter to survive changes on disk, and to end with the window.

## States

As a user, I want:

1. Before the first read lands, no rows and no empty message, so "not read yet" never reads as
   "nothing here".
2. When the first read fails, one error row in place of the list: `$(error)`, "Failed to load:" and
   the reason, the reason again in its tooltip, and one line in the Output for the failed read,
   however many views show it. No notification; this is the background tier. The next good read
   replaces it with rows. *ADR-0019, invariant 2*
3. An empty list to render its own message. No view hides itself. *commands.md, Where surfaces live*
4. With no folder open, or a folder that is not an instance of a mod manager Modbench recognizes, to
   be told so, never to fail silently. Every view that shows the instance says it in place of its
   rows, and says how to open an instance. The message waits for the check, so a folder not yet
   checked never reads as not an instance. An instance Modbench recognizes whose files cannot be
   read is story 2, not this. *ruling*
5. When the instance's game folder cannot be found, to be told once, the same way everywhere. The
   Toolbox's Game row shows `$(warning)` and "game folder not found", with a tooltip naming each
   place Modbench looked and the setting that fixes it. Every view whose rows need the game folder
   says so in its message line. One line in the Output. No notification; this is the background
   tier. Rows that do not need the game folder still show. A configuration that names no game is
   story 2; no configuration is story 4. *ADR-0019, invariant 2; ruling*

## The status bar

As a user, I want:

1. One item at the bottom left that says what mEdit is doing: `$(loading~spin) mEdit: Connecting…`,
   `$(plug) mEdit: Attached`, `$(error) mEdit: Disconnected`, `$(circle-slash) mEdit: Stopped`, or
   `$(check) mEdit: Ready (N plugin copies)` once the load order is indexed. It names no game.
   *ruling*
2. A click on it to do nothing: mEdit starts with the extension, and nothing starts it.
   *commands.md, No lifecycle gestures*
3. A disconnect reported, never adapted to: the views keep their rows. *ADR-0002, invariant 2;
   plugins.md, States, story 3*

## Reporting

ADR-0019 decides the tier; this table is how each tier looks on a surface.

| What happened | What I see |
|---|---|
| A read behind the view failed | the error row above, and a line in the Output |
| A gesture I started failed, or was refused | a notification saying why, and a line in the Output |
| A gesture landed, but part of it failed, so a view would show something untrue | a notification naming the part that failed, and a line in the Output. The gesture is not reported as failed. |
| A gesture over a selection landed for some items and failed for others | one notification naming each item that failed and why, and a line in the Output. The items that landed are not reported as failed. |
| A failure inside a dialog I am answering | a line in the Output. The dialog says it; a second notification on top of it does not. |

