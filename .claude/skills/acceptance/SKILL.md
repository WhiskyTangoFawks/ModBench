---
name: acceptance
description: A throwaway Modbench instance, headless, driven through its MCP server. Use to verify a gesture end to end, or to run an epic's acceptance.
---

# Acceptance

An acceptance run meets Modbench as the user's agent does: a real Extension Development Host, the backend it spawns, and an instance the run may wreck. The run acts and reads through the MCP server ([agent.md](../../../docs/architecture/surfaces/agent.md)) and checks the files on disk. Its evidence is what a call returned or what a file holds, quoted.

## A run

1. Build this worktree: in `modbench/`, through slot-run, `npm run build`, and `npm run build:backend` when `MEditService/` changed.
2. `accept.sh up` copies `DevList` into a new folder under `/tmp`, seeds its index, starts VS Code on it, and waits until the index is ready. It prints `DIR=<folder> PORT=<port>`.
3. `accept.sh tools <folder>` lists the tools and their inputs. `accept.sh call <folder> <tool> '<json>'` calls one and prints what it returned; a refusal exits non-zero.
4. `accept.sh down <folder>`, pass or fail. It stops every process with a file open in the folder, the backend included, and deletes the folder.

**Criterion:** each claim in the report quotes a call's result or a file's content, and `accept.sh down` printed `down:`.

One run is up at a time: a host and its index hold gigabytes of memory, and `up` refuses while another run is up. The Windows VM holds 6 GB too; start a run only while no gate run is using the VM.

## The index seed

A cold index of the Fallout 4 load order takes about 8 minutes. A run that copies a seed is ready in about 90 seconds. `accept.sh seed` makes the seed with one cold run, kept in `~/.local/share/modbench-accept/seed`. A stale seed costs time and never correctness, because Modbench revalidates derived state by content ([ADR-0003](../../../docs/adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md)). Seed again when the game updates or the index format changes.

## Outside a run's reach

The agent's requests open no picker, prompt or confirmation (agent.md, Reporting, story 2), and the agent never refreshes (agent.md, Gestures, story 3). A run cannot see menus, keys, what a tree row draws, or MO2 itself. The report names each such claim as unverified.
