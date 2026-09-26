---
name: orchestrate
description: Work a PRD's ticket stack from a single go. Lane the tickets by file surface, dispatch executors to worktrees, land serially, report on the PRD.
disable-model-invocation: true
---

# Orchestrate

Your goal is the delivery of the PRD. The executor's goal is its ticket. Deferral belongs to the user. Work inside your goal gets done in this run, and work outside it is the user's to rule on. A defect the run finds is inside your goal.

Read tickets and reports, avoid reading source. Every file you open is context you will not have later in the run- spend your context wisely.

Land serially by surface. Tickets that touch one file share a lane. A branch merges alone, and only after it contains current `main`.

Verified means observed. An executor's report is a claim until it quotes what ran. Merge on evidence, or ask for the evidence first.

The run never waits, but it can ask. A ping is a question with a default, and the default is to continue. A park stops the ticket, not the lane.

## 1. Lane

The stack is a PRD's `ready-for-agent` sub-issues with their blocking edges. Edges decide what can start. File surface decides what can run beside what.

Read each ticket once, with its comments and its PRD's comments, and name the files it touches, and what tier model it needs based on the complexity. Cut the stack into lanes so that tickets sharing a file share a lane. Work is serial within a lane and parallel across lanes. Run 3 lanes at most.

**Criterion:** every ticket sits in one lane, and no two lanes name the same file.

## 3. Dispatch

Present the lanes with one line per ticket, and the model tier the ticket will run on.

Before the first dispatch, confirm that `git symbolic-ref -q HEAD` names `refs/heads/main` and that `git status --porcelain` prints nothing. If either check fails, refuse and give the reason.

For each ticket, assign yourself and start one fresh `general-purpose` agent with `isolation: "worktree"` and `run_in_background: true` on the specified model tier. The agent's working directory is its own worktree under `.claude/worktrees/`, cut from local `HEAD` (`worktree.baseRef` is `head` in this project's local settings, since a run never pushes), and its first act is `git checkout -b fix-<n>-<slug>`. A global hook blocks EnterWorktree for subagents, so the executor never leaves that directory. If the ticket touches a directory whose dependencies are gitignored and slow to install, such as `node_modules`, tell the executor to symlink it from the checkout.

Keep the agentId, because `SendMessage` carries every later exchange. Within a minute, confirm the agent's transcript is still growing: one that stopped at its first tool call is dead, and a message to a dead agent is queued, never delivered, so respawn rather than wait. The prompt is `BRIEF.md` verbatim, followed by the fillings it needs:

- the ticket number, its full text, and every comment on the ticket and on its PRD, oldest first (`gh issue view <n> --comments`). A ruling posted as a comment amends the body, so the executor builds to the latest word, not the first.
- **landed since**, the list of what this run has already merged only if it changes the ticket's ground
- the rulings from step 2
- the branch name to create; the worktree is the agent's working directory

Dispatch each further lane while the first executor is still implementing.

**Criterion:** the agentId is held, the prompt is the brief plus fillings, the executor is running in the background, and its transcript grew past the first call.

## 4. Land

When an executor reports committed, work through these in order.

1. Run `git merge-base --is-ancestor main <branch> || { echo REFUSED; exit 1; }`. The only exemption is a branch whose `git diff --name-only main...<branch>` lists nothing outside `docs/` and root-level `*.md`.
2. Compare the test count before and after. A drop stops the merge unless every missing test is named as retired with the member it tested.
3. Run `bash .claude/skills/validate/run-gates.sh` with no flags in the branch's worktree: the comment gate alone, seconds. An executor's report is not evidence for this gate, because the editor-time hook does not fire on script-patched files.
4. Dispatch a reviewer with [`REVIEW.md`](REVIEW.md) as its brief, the rulings as pre-accepted, and the report's deviations named. Merge on MERGE. On HOLD, send the blocking findings to the executor with the rulings, and re-verify with the same reviewer after the fix commit. You read the verdict, never the code.
5. Run the tripwires:
   - When the report says "no behaviour change", diff the wire format and the public signatures.
   - Check whether the spec now claims Implemented for anything this ticket did not build.
   - For a new cross-boundary import, name what it drags with it.
   - When a named surface was wired, retired or renamed, grep `CLAUDE.md`, the specs and adjacent doc comments for present-tense claims about it.
6. Run `git -C <checkout-absolute-path> merge --no-ff <branch>`.
7. Never edit the spec. `docs/architecture/`, the ADRs, `CONTEXT.md` and every `CLAUDE.md` are the user's source of truth, and no agent modifies them under any condition without the user's explicit approval of the exact text. Where the outcome leaves the spec out of step, such as a status that should flip, write the exact before/after text for the drain.
8. Close the ticket. Anything that needs human eyes is noted for the drain, since verification happens at the PRD.
9. Remove the worktree (`git worktree remove .claude/worktrees/<name>`) and delete the branch.
10. Tell the other executor what landed and the new baseline test count, in one line.
11. Sort the report's **findings**. A defect the run finds is the run's to fix, whatever ticket or PRD it sits under and however old it is. Each finding takes one of four routes:
   - A defect, or a finding that serves the PRD, inside the reporting executor's surface: message that executor the finding along with landed-since and rulings, and it lands with the ticket.
   - A defect, or a finding that serves the PRD, outside that surface: start a fresh executor with a brief you write.
   - A defect whose fix needs an architecture or specification change (`docs/architecture/`, an ADR, `CONTEXT.md`, a `CLAUDE.md`): hold it for the drain with the exact before/after text proposed. The user owns those, and no agent edits them without the user's approval of the exact text.
   - Anything else: hold it for the drain.

   A dispatched finding gets no ticket and no comment.

The tracker is yours to read, assign, close and comment on. Tickets come from the user.

**Criterion:** merged, spec text proposed where one is needed, ticket closed, worktree gone, `main` clean, other lanes told, findings sorted.

## 5. Drain

The run ends when the PRD is achieved. Post one comment on the PRD. It lists what landed, both ticketed and not, what needs human eyes and why, what parked and the question each park waits on, what was never dispatched, every held finding for the user's ruling, and every proposed spec edit as exact before/after text. The PRD is the user's review surface.

**Criterion:** the comment is posted, no worktree remains, and `main` is clean.

## Unattended mechanics

When an executor parks, comment its question on the ticket, unassign, ping the user, and continue the lane. If an answer arrives before the drain, the ticket re-queues at the back.

The transcript carries one artifact, a status line, printed on each status change: `#542 building | #538 landing | #540 landed — 3 queued`. Send a `PushNotification` on a park, a land, and the drain.

A reviewer that returns without a verdict died.

A message sent to a stopped agent vanishes. The delivery receipt is the artifact it was supposed to produce. An agent that died may also have finished. In both cases, read the worktree and `git log` before re-sending or respawning.
