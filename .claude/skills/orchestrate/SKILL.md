---
name: orchestrate
description: Work an epic's ticket stack from a single go. Lane the tickets by architecture box, dispatch executors to worktrees, land serially, report on the epic.
disable-model-invocation: true
---

# Orchestrate

Your goal is the delivery of the epic. The executor's goal is its ticket. Deferral belongs to the user. Work inside your goal gets done in this run. A defect the run finds is inside your goal. Root CLAUDE.md's chain of authority decides what reaches the user.

Resolve before you route. A stop, break or question an executor or reviewer raises is a claim until you have worked it through the chain yourself: the principles, the ADRs the work touches, the spec, and CONTEXT.md's words, as they stand on `main`. What the chain answers goes back to the lane as the answer, with the texts quoted. Two things reach the user: two documents at one level that disagree, and a need no document speaks to, each with your attempt quoted.

Read tickets, reports and the chain's documents; leave source to the executors. Every source file you open is context you will not have later in the run- spend your context wisely.

Land serially by box. Tickets that touch one box share a lane. A branch merges alone, and only after it contains current `main`.

Verified means observed. An executor's report is a claim until it quotes what ran. Merge on evidence, or ask for the evidence first.

The run never waits. A tactical question is decided, and a strategic one parks its ticket. A park stops the ticket, not the lane.

## 1. Lane

The stack is an epic's `ready-for-agent` sub-issues with their blocking edges. Edges decide what can start. Boxes decide what can run beside what.

A box is a module `docs/architecture/target-architecture.d2` draws, or a band's lib, and its folder is the unit the kernel scans hold: a folder under `modbench/src/`, or an `MEditService.*` project. Read each ticket once, with its comments and its epic's comments, and name the boxes it touches and the tier it runs on: the one its Notes name, else Sonnet. Raise a ticket's tier only when its text leaves a judgement the chain does not answer, and say why in its lane line. A ticket you would raise for size alone is too coarse: park it for the user to split rather than spend the larger tier on it. Cut the stack into lanes so that tickets touching one box share a lane. Work is serial within a lane and parallel across lanes. Run 3 lanes at most.

Three things sit outside that rule:

- A generated file, such as `api.ts`, belongs to no lane. A branch regenerates it after merging `main`.
- The composition root is a box of its own: `modbench/src/*.ts`, `modbench/package.json` and `MEditService.Http`'s `Program.cs`. Two tickets that edit it share a lane.
- A box's interface file has one owner per wave. When several tickets need another box's interface changed, that change runs first as an expand step, and it threads the composition root's wiring at the same time. The callers then run in parallel against it, each inside its own box. If the epic holds no expand ticket, dispatch the change as a finding.

**Criterion:** every ticket sits in one lane, no two lanes name the same box, and every interface change a caller needs lands ahead of it.

## 2. Dispatch

Present the lanes with one line per ticket, and the model tier the ticket will run on.

Before the first dispatch, confirm that `git symbolic-ref -q HEAD` names `refs/heads/main` and that `git status --porcelain` prints nothing. If either check fails, refuse and give the reason.

For each ticket, assign yourself and start one fresh `general-purpose` agent with `isolation: "worktree"` and `run_in_background: true` on the specified model tier. The agent's working directory is its own worktree under `.claude/worktrees/`, cut from local `HEAD` (`worktree.baseRef` is `head` in this project's local settings, since a run never pushes), and its first act is `git checkout -b fix-<n>-<slug>`. A global hook blocks EnterWorktree for subagents, so the executor never leaves that directory. If the ticket touches a directory whose dependencies are gitignored and slow to install, such as `node_modules`, tell the executor to symlink it from the checkout.

Keep the agentId, because `SendMessage` carries every later exchange. Within a minute, confirm the agent's transcript is still growing: one that stopped at its first tool call is dead, and a message to a dead agent is queued, never delivered, so respawn rather than wait. The prompt is `BRIEF.md` verbatim, followed by the fillings it needs:

- the ticket number, its body, and every comment on the ticket and on its epic, oldest first (`gh issue view <n> --json number,title,body,labels,comments`). The ticket's spec lines are its work, and the comments are context.
- **landed since**, the list of what this run has already merged only if it changes the ticket's ground
- the branch name to create; the worktree is the agent's working directory
- **its boxes**: the boxes its lane owns, and the boxes the open lanes hold, which it stays out of

Dispatch each further lane while the first executor is still implementing, and create each worktree only after the one before it exists, since two created at once race.

**Criterion:** the agentId is held, the prompt is the brief plus fillings, the executor is running in the background, and its transcript grew past the first call.

## 3. Land

When an executor reports committed, work through these in order.

1. Run `git merge-base --is-ancestor main <branch> || { echo REFUSED; exit 1; }`. The only exemption is a branch whose `git diff --name-only main...<branch>` lists nothing outside `docs/` and root-level `*.md`.
2. Compare the test count before and after. A drop stops the merge unless every missing test is named as retired, with the member it tested or the test that now holds its case.
3. Run `bash .claude/skills/validate/run-gates.sh --comments` in the branch's worktree: the comment gate alone, seconds. An executor's report is not evidence for this gate, because the editor-time hook does not fire on script-patched files.
4. Dispatch a reviewer with [`REVIEW.md`](REVIEW.md) as its brief and the breaks the report names. Merge on MERGE. On HOLD, send the blocking findings to the executor, and re-verify with the same reviewer after the fix commit. The executor reverts a change to a maintainer's document, and you quote the reverted diff as a break for the drain. You read the verdict, never the code.
5. Run the tripwires:
   - When the report says "no behaviour change", diff the wire format and the public signatures.
   - Check whether README's status table now claims Implemented for anything this ticket did not build.
   - For a new cross-boundary import, name what it drags with it.
   - When a named surface was wired, retired or renamed, grep `CLAUDE.md`, the specs and adjacent doc comments for present-tense claims about it. A stale doc comment is fixed; a stale claim in a maintainer's document is a break for the drain.
6. Run `git -C <checkout-absolute-path> merge --no-ff <branch>`.
7. Where the outcome leaves a maintainer's document out of step with the code, such as a README status that should flip, quote it as a break for the drain.
8. Close the ticket. Anything that needs human eyes is noted for the drain, since verification happens at the epic.
9. Remove the worktree (`git worktree remove .claude/worktrees/<name>`) and delete the branch.
10. Tell every open executor what landed and the new baseline test count, in one line.
11. Sort the report's **findings**. A defect the run finds is the run's to fix, whatever ticket or epic it sits under and however old it is. Each finding takes one of four routes:
   - A defect, or a finding that serves the epic, inside the reporting executor's boxes: message that executor the finding along with landed-since, and it lands with the ticket.
   - A defect, or a finding that serves the epic, outside them: start a fresh executor with a brief you write, in the lane of the box it touches.
   - A finding whose root lives in a maintainer's document, once resolution leaves it open: a break or a strategic question for the drain, in the chain of authority's form.
   - Anything else is dropped.

   A dispatched finding gets no ticket and no comment.

The tracker is yours to read, assign, close and comment on. Tickets come from the user.

**Criterion:** merged, breaks quoted for the drain, ticket closed, worktree gone, `main` clean, other lanes told, findings sorted.

## 4. Drain

The run ends when the epic is achieved. Post one comment on the epic. It lists what landed, both ticketed and not, what needs human eyes and why, what parked and the strategic question each park waits on, what was never dispatched, and every break in the chain of authority's form. Tactical decisions stay in the commit messages. The epic is the user's review surface. If everyticket is closed and no open questions remain, close the epic ticket.

**Criterion:** the comment is posted, no worktree remains, and `main` is clean.

## Unattended mechanics

When an executor parks, resolve its question. An answer the chain gives goes back to the executor, and the ticket goes on. A question that survives: comment it on the ticket, unassign, and continue the lane.

Authority is `main`. An unmerged branch decides nothing. A maintainer's document that lands on `main` mid-run is the new ground: tell every open executor, and each branch builds to it. The user answers in a session, and the answer lands where its root lives. If an answer lands before the drain, the ticket re-queues at the back.

The transcript carries one artifact, a status line, printed on each status change: `#542 building | #538 landing | #540 landed — 3 queued`. Send a `PushNotification` on a park, a land, and the drain.

A reviewer that returns without a verdict died.

A message sent to a stopped agent vanishes. The delivery receipt is the artifact it was supposed to produce. An agent that died may also have finished. In both cases, read the worktree and `git log` before re-sending or respawning.
