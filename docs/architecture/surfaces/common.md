# Common: what every surface shares

Each surface spec holds what is particular to its view and points here for the rest. The gestures and their Arguments are in [commands.md](../commands.md), with the Chrome rules for a view's title bar.

Each story cites its source. A story with no source is owned here.

## A view

As a user, I want:

1. Every list to be a native VS Code tree view, so selection, keyboard navigation, drag and the context menu behave as they do everywhere else in VS Code. Source: Mutagen's data, the reference's behaviour, VS Code's interaction
2. Every view to follow the disk: a change on disk, from Modbench, MO2 or any other tool, shows up with no action of mine. A view has no refresh of its own. Source: ADR-0015; Chrome
3. A row's icon, badge or colour to carry its status. The description repeats the status only when it is not the default, so an unmarked row reads as the ordinary case.
4. View state (a sort, a toggle) to reset when the extension activates. It is a lens, not a setting.
5. Keys and mouse on a tree to do what VS Code's own trees do, as in the Explorer: Space toggles a check box, Delete destroys, F2 renames, Ctrl+C copies, Ctrl+Alt+F and F3 find. A key acts only while the tree has focus and no input box does, as VS Code's list keys do. Modbench adopts no key from xEdit or MO2. Source: Mutagen's data, the reference's behaviour, VS Code's interaction
6. Every list to let me select several rows, and a gesture to act on the whole selection unless it only makes sense for one row, which its Argument in the catalog says.
7. Every list to reverse its order from its title bar. The direction never changes what the order means, such as which item wins. Source: CONTEXT.md, Sort direction
8. Ctrl+C, or the menu's copy value, to copy the selection as text, one item to a line, each as its surface says it copies. Source: catalog `copy value`

## The name filter

One filter on every list. As a user, I want:

1. To open it from the title bar's first slot. It has no key: Ctrl+Alt+F and F3 stay VS Code's own Find on the tree (A view, story 5). Source: catalog `filter`
2. Typing to narrow the list live, by case-insensitive substring of the row's label.
3. The filter to stay when the input box closes by any route: Enter, Esc, a click on a row or elsewhere. Reopening the box shows the term, to edit.
4. To clear it only on purpose: the first slot becomes a clear icon (`$(clear-all)`) while a filter is active, and emptying the term also clears it. Source: Chrome
5. The view's description to show the active term.
6. A filter that matches nothing to say so, naming the term, rather than show an empty view.
7. The filter to survive changes on disk. It is view state (A view, story 4).

## States

As a user, I want:

1. Before the first read lands, no rows and no empty message, so "not read yet" never reads as "nothing here".
2. When the first read fails, one error row in place of the list: `$(error)`, "Failed to load:" and the reason, the reason again in its tooltip, and one line in the Output for the failed read, however many views show it. No notification; this is the background tier. The next good read replaces it with rows. Source: ADR-0019
3. An empty list to render its own message. Source: commands.md, Where surfaces live
4. With no folder open, or a folder that is not an instance of a mod manager Modbench recognizes, to be told so. Every view that shows the instance says it in place of its rows. The message says how to open an instance. It waits for the check, so a folder not yet checked never reads as not an instance. The view's title-bar gestures that need an instance are absent. An instance whose files cannot be read is story 2. Source: commands.md, No dead entries
5. When the instance's game folder cannot be found, to be told once, the same way everywhere. The Toolbox's Game row says where Modbench looked ([toolbox.md](toolbox.md)). Every view whose rows need the game folder says so in its message line. One line in the Output. No notification; this is the background tier. Rows that do not need the game folder still show, and the records mEdit shows stay as they were until the folder is found. A configuration that names no game is story 2; no configuration is story 4. Source: ADR-0019
6. When a later read fails, the rows I had to stay, and the view's message line to say "Showing the last good read:" and the reason, with one line in the Output. No notification. The next good read clears it. Source: ADR-0019

## A gesture that writes

By commands.md, A gesture ends when the disk shows it. As a user, I want:

1. The view's progress bar from my click until the read that follows the gesture's write lands, and nothing in the view to change until then. Source: ADR-0015
2. Every value I see to be the disk's. A view shows what each read holds, whoever wrote it, and never a value it remembers from my gesture. Source: ADR-0003
3. A gesture whose read fails to end with it: the rows I had stay and the message line says so (States, story 6). Source: ADR-0019

## The status bar

As a user, I want:

1. One item at the bottom left that says what mEdit is doing: `$(loading~spin) mEdit: Starting…`, `$(plug) mEdit: Running`, `$(error) mEdit: Disconnected`, `$(circle-slash) mEdit: Stopped`, or `$(check) mEdit: Ready (N plugins)` once the snapshot is indexed, N counting the active plugins. It names no game.
2. A click on it to do nothing. mEdit starts with the extension, and no gesture starts or stops it. Source: commands.md, No lifecycle gestures for mEdit
3. A disconnect reported, never adapted to: the views keep their rows. Source: ADR-0002

## Reporting

ADR-0019 decides the tier; this table is how each tier looks on a surface.

| What happened | What I see |
|---|---|
| The first read behind the view failed | the error row (States, story 2), and a line in the Output |
| A later read behind the view failed | the rows stay, and the message line says so (States, story 6), and a line in the Output |
| A gesture I started failed, or was refused | a notification saying why, and a line in the Output |
| A gesture landed, but part of it failed, so a view would show something untrue | a notification naming the part that failed, and a line in the Output. The gesture is not reported as failed. |
| A gesture over a selection landed for some items and failed for others | one notification naming each item that failed and why, and a line in the Output. The items that landed are not reported as failed. |
| Something Modbench does on its own, such as a sync, fails | the view's message line, and a line in the Output, once, and again only when the reason changes |
| A failure inside a dialog I am answering | a line in the Output. The dialog says it; a second notification on top of it does not. |

