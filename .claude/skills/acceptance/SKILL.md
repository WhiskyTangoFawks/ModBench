---
name: acceptance
description: A throwaway Modbench instance, headless, driven through its MCP server. Use to verify a gesture end to end, or to run an epic's acceptance.
---

# Acceptance

An acceptance run meets Modbench as the user's agent does: a real Extension Development Host, the backend it spawns, and an instance the run may wreck. The run acts and reads through the MCP server ([agent.md](../../../spec/surfaces/agent.md)) and checks the files on disk. Its evidence is what a call returned or what a file holds, quoted.

## A run

1. Build this worktree and start the run in one slot, so no other run takes the slot between them: `SLOT_KEEP_SCOPE=1 bash .claude/skills/validate/slot-run.sh bash -c 'cd modbench && npm run build && npm run build:backend && cd .. && .claude/skills/acceptance/accept.sh up <game>'`. Leave out `npm run build:backend` when `MEditService/` did not change.
2. `accept.sh up <game>`, which step 1 runs, takes `fallout`, `skyrim` or `starfield`, whichever the case needs, or the path of an instance folder. It copies `DevList<Game>` into a new folder under `/tmp`, seeds its index, starts VS Code on it, and waits until the index is ready. It prints `DIR=<folder> PORT=<port>`. A folder you name gets no seed. A game takes two options, made as `up` brings the instance up:
   - `--game-folder` links the Steam install into the instance as `game/` and sets `gamePath` to it, so the game's archives and loose files take part. Without it the game folder is outside the instance.
   - `--source` makes `MB-DEV Conflict A` a source mod in a repository of its own, and commits records beside `MBDevItemA` that name a file the mod holds, a file `Conflict B` holds, and a file a vanilla archive holds. `MBDevItemA` names none.
3. Shape the instance for the case. A change Modbench owns goes through its gestures: install, create empty mod, add separator, create plugin, build. A change it does not own is a plain file in the run's folder: a package in `downloads/`, a file in a mod folder, a profile's mod order. The report lists each shaping step, so another run can repeat the case. A shape that two cases need moves into that game's `DevList<Game>`.
4. Act and observe. `accept.sh tools <folder>` lists the tools and their inputs. `accept.sh call <folder> <tool> '<json>'` calls one and prints what it returned; a refusal exits non-zero.
5. `accept.sh down <folder>`, pass or fail. It stops every process with a file open in the folder, the backend included, and deletes the folder.

**Criterion:** the report lists the shaping steps, each claim in it quotes a call's result or a file's content, and `accept.sh down` printed `down:`.

One run is up at a time: a host and its index hold gigabytes of memory, and `up` refuses while another run is up. `up` runs through `slot-run.sh`, so it waits for a gate run or the Windows VM, and while the run is up every other `slot-run.sh` waits and names it. The slot frees when every process `up` recorded in the run's `pids` file, Xvfb, VS Code and the backend, has exited, `accept.sh down` or not. Step 1's one `slot-run.sh` holds the slot from the build into the live run. `up` alone, after a separate build, leaves the slot free between them. A run of your own while it is up: `SLOT_INSIDE=acceptance bash .claude/skills/validate/slot-run.sh <command>`, or the same variable before `run-gates.sh`.

## The index seed

A cold index takes minutes: about 8 for Fallout 4, 3 for Skyrim, under 15 for Starfield. A run that copies its game's seed is ready in 40 to 100 seconds after `up` starts it. Starfield's seed is 23 GB, so its `up` returns about 5 minutes after the command, because the copy comes first. `accept.sh seed <game>` makes that game's seed with one cold run, kept in `~/.local/share/modbench-accept/seed/<game>`. Make a game's seed before its first run. A stale seed costs time and never correctness, because Modbench revalidates derived state by content ([ADR-0003](../../../spec/adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md)). Seed again when the game updates or the index format changes.

## Outside a run's reach

The agent's requests open no picker, prompt or confirmation (agent.md, Reporting, story 2). A run cannot see menus, keys, what a tree row draws, or MO2 itself. The report names each such claim as unverified.
