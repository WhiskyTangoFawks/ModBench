# Common: what every surface shares

Each surface spec holds what is particular to its view and points here for the rest. The gestures and their Arguments are in [commands.md](commands.md), with the Chrome rules for a view's title bar.

A view here is one Modbench draws. A view VS Code owns, such as the References view, behaves as VS Code made it (Existing tools).

Each story cites what decides it. A story that cites nothing is owned here.

## A view

As a user, I want:

1. Every list to be a native VS Code tree view, so selection, keyboard navigation, drag and the context menu behave as they do everywhere else in VS Code. Cites: Mutagen's data, the reference's behaviour, VS Code's interaction
2. Every view to follow the disk: a change on disk, from Modbench, MO2 or any other tool, shows up with no action of mine. A view has no refresh of its own. Cites: ADR-0015
3. A row's icon, badge or colour to carry its status, and its description to repeat it, only where the row is not in the ordinary case, so an unmarked row reads as the ordinary case.
4. View state, such as a sort, a toggle or a filter, to end with the window. It is a lens, not a setting. Cites: commands.md, Exclude and hide
5. Keys and mouse on a tree to do what VS Code's own trees do, as in the Explorer: a key fires the gesture VS Code binds it to, on a row that offers it. Cites: Mutagen's data, the reference's behaviour, VS Code's interaction
6. Every list to let me select several rows. Cites: commands.md, Argument; A selection is one gesture, and each item lands on its own
7. Every list to reverse its order from its title bar. The direction never changes what the order means, such as which item wins. Cites: GLOSSARY.md, Sort direction
8. Ctrl+C, or the menu's copy value, to copy the selection as text, one item to a line. Cites: catalog `copy value`
9. A copy of a record to open as one document, whichever view or VS Code feature opens it: one tab for one copy, and a tab restored after a restart opens the same copy again. Cites: VS Code's interaction; ADR-0012
10. Every page Modbench draws to take VS Code's theme, so they look as the rest of VS Code does. Cites: VS Code's interaction
11. A collapsed row to carry the badges of the rows beneath it, and an expanded row only its own, so each change shows once, on the row I can see.
12. Ctrl+F in a page Modbench draws to find text as in any editor, among what the page shows. Cites: VS Code's interaction

## The name filter

One filter on every list. As a user, I want:

1. To open it from the title bar. It has no default key, so VS Code's Find on the tree keeps its keys. Cites: catalog `filter`; commands.md, Chrome
2. Typing to narrow the list live, by case-insensitive substring of the row's label.
3. The filter to stay when the input box closes, however it closes. Reopening the box shows the term, to edit.
4. To clear it only on purpose: its icon becomes a clear while a filter is active, and emptying the term also clears it. Cites: Chrome
5. The view's description to show the active term.
6. A filter that matches nothing to say so, naming the term, rather than show an empty view.
7. The filter to survive changes on disk. It is view state (A view, story 4).

## States

As a user, I want:

1. Before the first read lands, no rows and no empty message, so "not read yet" never reads as "nothing here".
2. When the first read fails, one error row in place of the list, naming the reason, and one line in the Output for the failed read, however many views show it. The next good read replaces it with rows. Cites: ADR-0019
3. An empty list to render its own message. Cites: commands.md, Where surfaces live
4. With no folder open, or no open folder that is an instance of a mod manager Modbench recognizes, to be told so. Every view that shows the instance says it in place of its rows. The message says how to open an instance. Cites: commands.md, No dead entries
5. When the instance's game folder cannot be found, to be told once, the same way everywhere. The Toolbox's Game row says where Modbench looked ([toolbox.md](toolbox.md)). Every view whose rows need the game folder says so in its message line. One line in the Output. Rows that do not need the game folder still show, and the records mEdit shows stay as they were until the folder is found. Cites: ADR-0019
6. When a later read fails, the rows I had to stay, and the view's message line to say "Showing the last good read:" and the reason, with one line in the Output. The next good read clears it. Cites: ADR-0019
7. An instance whose game Modbench does not support refused when it opens, naming the game, and no file of it written. Cites: Never break the instance for its owner
8. A warning, when the mod manager that made the instance is running, that it overwrites my changes when it launches a program or exits. Cites: Never break the instance for its owner; Never silently wrong
9. One instance in each window: the first open folder that is an instance, chosen when Modbench starts. No view shows the other open folders, which stay VS Code's, and each other instance among them gets one line in the Output naming it. Cites: Existing tools

## A gesture that writes

By commands.md, A gesture that writes ends when the read model shows it. As a user, I want:

1. The view's progress bar from my click until the read that follows the gesture's write lands, and nothing in the view to change until then but what VS Code's own control changes as I click it, such as a check box. Cites: ADR-0015; Mutagen's data, the reference's behaviour, VS Code's interaction
2. Every value I see to be the read model's, whoever wrote it. Cites: ADR-0015; ADR-0003
3. A gesture whose read fails to end with it: the rows I had stay and the message line says so (States, story 6). Cites: ADR-0019

## The status bar

As a user, I want:

1. One item at the bottom left that names mEdit's state, and the count of active plugins once the snapshot is indexed.
2. A click on it to do nothing. Cites: commands.md, No lifecycle gestures for mEdit
3. When mEdit exits or fails to start, the item to say it stopped, the Output to log why, and an error notification to say mEdit stopped and that reloading the window starts it again. Nothing starts it again on its own. Cites: Never silently wrong
4. A disconnect reported, never adapted to: the views keep their rows. Cites: ADR-0002

## Reporting

The Output is the log: a line for each thing that happened. The Problems panel is the dashboard: a problem for each state that is wrong, on the file it concerns, while the state holds.

A notification is for what I started, or for a view left showing something untrue (ADR-0019). For anything else my script or my agent asked, the reason goes back to it, and the Output logs it.

ADR-0019 decides the tier; this table is how each tier looks on a surface.

| What happened | What I see |
|---|---|
| The first read behind the view failed | the error row (States, story 2), and a line in the Output |
| A later read behind the view failed | the rows stay, and the message line says so (States, story 6), and a line in the Output |
| A gesture I started failed, or was refused | a notification saying why, and a line in the Output |
| A gesture landed, but part of it failed, so a view would show something untrue | a notification naming the part that failed, and a line in the Output |
| A gesture over a selection landed for some items and failed for others | one notification naming each item that failed and why, and a line in the Output |
| Something Modbench does on its own, such as a sync, fails, and every view stays true | the view's message line, and a line in the Output, once, and again only when the reason changes |
| Something Modbench does on its own fails, and a view now shows something untrue, such as a record filter it cleared | a notification naming what changed and why, and a line in the Output |
| Modbench could not hash a file it reads | a problem on that file in the Problems panel while it holds, and a line in the Output |
| A failure inside a dialog I am answering | a line in the Output. The dialog says it; a second notification on top of it does not. |
