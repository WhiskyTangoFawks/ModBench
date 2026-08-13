---
name: mutation-test
description: Mutation-test review — read mutation results as a code review, triaging every surviving or uncovered mutant to a recorded disposition. Use to run and review mutation test results after a TDD implementation.
---

A code-review pass that uses mutation results as its reading list.

A correct `/tdd` slice writes only code a test demanded, so its mutants all die. Each survivor or uncovered result is a potential code smell pointing at one of the two ways a slice goes wrong: speculative generality, or mechanism-not-outcome. Read each finding the way a reviewer reads a PR: *show me the requirement that earns this line its place.*

The review is complete when **every finding carries exactly one recorded disposition**.
A run that ends in documented accepts passes exactly as a run that ends in deletions
does.

## Process

### 1. Collect the findings

Run the project's mutation tool scoped to the working dif, or take the results the caller supplied. List every `Survived` and `NoCoverage` mutant with its file, line, and mutator type.

### 2. Interrogate each finding

Answer for each finding: what specified user-facing requirement does the line serve? Read the surrounding code, the tests that cover the line, the spec or issue behind it. The answer routes the finding:

| Answer | Route |
| --- | --- |
| None | **A — the code hasn't earned its place** |
| A requirement, tests cover the line, yet the mutant lived | **B — the test is weak** |
| A requirement, but no test observes it | **C — a real gap** |


**Executed is not constrained.** A file whose mutants nearly all *survive* rather than
show as uncovered is not thereby a route-B file. Its tests may assert outcomes perfectly
well while their fixtures fail to discriminate the branches — a lone `Data/` folder that
satisfies two different code paths identically leaves no assertion able to tell them
apart. That is a missing scenario, which is route C. Read the covering tests before
concluding either way; the survived-to-uncovered ratio does not decide it.

Fast path — on `Equality` / `Conditional` / `Null coalescing` mutators, first check
whether both branches are provably equal *at exactly the mutation point* under an
invariant elsewhere (an enum-severity ordering, a sentinel no real value can match,
mutually-exclusive data sources). If the invariant exists, record **Equivalent** and
move on.

**Done when** every finding has a route.

### 3. Assign one disposition

Within the finding's route, record the first disposition that fits. Across routes the
preference is A over B over C: changing the code beats changing a test beats adding
one.

**A disposition that changes code is a behavior claim, and mutation testing cannot
check it.** A run scores the code as written; it has no opinion on whether the code
still does what it did before. So state what the old code produced and what the new code
produces — as outputs or sets, not as a description of the mutation site — and name the
input that distinguishes them. If none exists, say so.

*"This branch is unreachable"* licenses **removing** it. It does not license replacing
it with something else. One slice deleted an unreachable branch on exactly that correct
premise and, in the same edit, mapped the values through a different path, adding
members the original never had; every gate stayed green and a user-visible behavior
broke silently.

Your safety net is a **case**, not a file. A test that passes both before and after
proves nothing about the change.

**Route A — no requirement (code smells, `/code-review` vocabulary):**

- **Delete** (**Dead Code**, **Speculative Generality**) — guards impossible or
  unreachable state, or serves a need the spec doesn't have → remove it.
- **Simplify** (**Speculative Generality**) — the construct is stronger than the need
  (`?? ""` on a non-nullable) → rewrite so the mutation site ceases to exist.
- **Inline the middle man** (**Middle Man**) — the line only delegates onward → call
  the real target direct.
- **Unify the duplicate** (**Duplicated Code**) — the same logic lives elsewhere →
  extract one shared copy; coverage follows it. **Unifying is in scope when the
  duplication is what produced the findings**, and does not wait for its own ticket —
  deferring it to keep a diff small is the most common way this route gets missed.
  Twice the duplication was the very thing making the surrounding dispositions correct:
  an equivalence that holds only because of who calls a function is an equivalence a
  second copy quietly erodes.
- **Accept as invariant** — a defensive check at a trust boundary with no behavior a
  requirement-level test could observe → record why the code exists *and* why no test
  can see it.
- **Equivalent** — the mutation cannot change observable behavior → record the
  invariant that makes it.

**Route B — covered, yet survived (test smells):**

- **Fix the assertion** — the test asserts mechanism, not outcome, so the mutant slips
  past it. Name the smell from the taxonomy below and rewrite the assertion against
  observable behavior.

**Route C — a requirement with no test:**

- **Red-green** — the behavior is user-visible and unspecified → get the requirement,
  then run a full feature-level red-green cycle (`/tdd`).
- **Request a fixture** — the guard handles malformed external data you cannot
  synthesize → the code is likely genuinely needed; ask the developer for real data,
  then write the behavioral test against it.
- **Refactor the seam** — the behavior is real but hidden behind a dependency no test
  can reach → expose the seam, then test at it.

**Done when** every finding records exactly one disposition.

### 4. Report the table, then act

**The table comes first, and nothing is edited before it is approved.** Report every
finding → route → disposition, and wait. This gate exists because the failure mode is
specific and recurring: an agent facing a long survivor list starts killing mutants one
by one, and "one new test per survivor" is the single worst outcome this skill can
produce — it re-couples the suite to internals, which is the exact damage `/tdd` exists
to prevent. A list of fifty survivors in one file is not fifty pieces of work; it is
usually one or two, and the table is where that becomes visible.

Two rules bind the table:

- **A surviving mutant is never, on its own, a justification for a test.** The
  justification is a requirement. If you cannot name the requirement, the finding is
  route A and the answer is to delete or simplify the code — not to cover it.
- **Watch what is driving your routes.** Reaching for C repeatedly *can* mean step 2 is
  being skipped — routes assigned by what would kill the mutant rather than by what the
  code is for. It can equally mean the code genuinely is unconstrained: a file whose
  fixtures never discriminate its branches produces honest C rows in bulk. The test is
  whether every row names its requirement, not how many rows share a route.

**What the gate checks.** Before the table is approved, it must survive:

- **The count adds up.** Sum the groups and state the sum. One table reported `✓ 66`
  over groups summing to 60; the six missing findings existed only in prose, where
  nobody could check them.
- **No row contradicts another.** A finding accepted as unobservable, in a table that
  also proposes a test asserting the very thing that would observe it, means one of
  those two rows is wrong. Read the table against itself before sending it.
- **Route C names a requirement, not a mutant.**
- **Every code-changing disposition carries its differential** (§3).
- **Duplication found during triage is dispositioned, not deferred.**

Once the table is approved:

- Local fixes (delete, simplify, inline, unify, fix the assertion): apply, then rerun
  the tests.
- Architectural work (seam refactors, red-green cycles needing a new requirement):
  surface to the developer with the analysis and a recommendation — these are proposals
  even after the table is approved, because each one needs its own requirement.
- Accepts and equivalents: record with their invariant.

**Verify against your prediction, not against the mutant.** Re-run afterwards and
compare each row's outcome to what its disposition *predicted*:

- Predicted accept, still survives → consistent. This is the common good case, not a
  shortfall.
- Predicted "the requirement is now constrained", still survives → **your understanding
  was wrong**, not your kill count. The test does not observe what you thought. Go back
  to step 2 and re-read the code. **Do not adjust the test until the mutant dies** —
  that is the degenerate path, and it produces precisely the internals-coupled assertion
  this skill exists to prevent.
- Predicted killed, killed → consistent, and on its own confirms nothing.

A row closes because a disposition is recorded and the evidence is consistent with it.
Never because a mutant died. The re-run is evidence about your reasoning; it is not a
scoreboard, and it has twice caught a test that could not fail — once where two distinct
failures produced indistinguishable observations, once where a fixture was built from
the very collection it asserted about.

Close with the table again: finding → disposition → applied / proposed.

**Done when** every disposition is either applied or handed to the developer with its
reasoning.

## Test-smell taxonomy

Vocabulary for route C — use these names so a mutation finding and a static-review
finding compose. Flag with concrete evidence from the test body.

- **mechanism-not-outcome** — asserts internal call counts, intermediate state, or
  private structure instead of observable behavior (`retries == 3`).
- **vacuous** — no assertion; only "does not throw"; or asserts a value it just set.
- **self-referential** — the expectation derives from the same source as the behavior:
  asserting against the very constant the code under test imports, or building a fixture
  out of the collection being verified. Both sides move together, so the test cannot
  fail. Invisible to coverage and to a static read of the diff — it looks like a normal
  passing test — and it has appeared twice.
- **over-mocking** — mock verifies mock; the test proves the wiring it declared.
- **coupled-literals** — exact strings, magic numbers, or ordering the spec never
  constrained.
- **redundant** — multiple tests exercising the same behavior; collapse candidates.
- **multi-behavior** — several unrelated behaviors asserted in one test.
- **testing-the-framework** — exercises library behavior rather than our own logic.

## Why dispositions, not a score

A kill-rate invites the cheapest way to raise it: a micro-test written to kill one
named mutant, asserting the very implementation detail the mutant touched — re-coupling
the suite to internals, the exact coupling `/tdd` exists to prevent. A disposition
invites the cheapest way to be honest, which is usually deletion.

So the rules hold in both directions: every test enters the suite through a requirement
and a full red-green cycle, and every accept enters the record with its invariant. That
is why a run of documented accepts is a pass, and an unexamined 100% kill-rate proves
nothing.

**The score re-enters at verification time if you let it.** Guarding the triage step is
not enough: once dispositions are applied, "is the mutant dead yet" becomes the only
cheaply-checkable proposition in the whole workflow, while every question worth asking —
is there a requirement, is this equivalent, has this code earned its place — needs
judgment. That asymmetry is why the pathology keeps returning, and why §4's verification
step is framed around predictions rather than kills. A mutant is never a target. Killing
one always has a degenerate solution available: assert the implementation detail it
touched.

## As a review axis

This skill also runs as a **third axis alongside `/code-review`**, whose two axes both read
what the code *says*. Only this one asks whether the suite would notice if it said something
else — a test that executes a line without constraining it looks identical to a good test in
a diff, and identical in a coverage report. It shows up only when the line is changed and
nothing goes red.

It is deliberately **not wired into `/code-review` itself**: that skill is third-party and
gets updated from upstream, so anything added to it is lost on the next update. The axis
lives here, in the repo that owns the runner, and the caller runs both and reports them side
by side (`/orchestrate` step 5 does exactly this).

**Start the run before the other axes, not with them.** It costs tens of minutes where they
cost a couple, so started first it overlaps their spec-hunting and standards-gathering and is
usually ready when they report. Run it as a background task and poll — it outlasts a
foreground command cap, and a foreground call killed partway looks exactly like a silent
failure. Pass the review's own fixed point as the scope, so the mutants and the diff under
review are the same set of files. Runner mechanics live next to the runner: `stryker/stryker.md`
for the C# side (invocation, exit codes — exit 3 "nothing in scope" and a non-zero exit for
survivors are both normal outcomes, not failures), `stryker/stryker-js.md` for the TypeScript
side. A diff touching both gets both, reported as one axis.

Then hand the runner's **parsed summary** — pasted inline, never the raw report — to one
sub-agent with this brief:

> Read `.claude/skills/mutation-test/SKILL.md` first; it defines the triage you are
> performing. Triage every finding to exactly one disposition using its routes — A (the code
> has no requirement: delete, simplify, inline, unify, accept-as-invariant, equivalent), B
> (covered but the assertion is weak: fix the assertion, naming the test smell), C (a real
> requirement with no test). Prefer A over B over C. For each finding give file:line, route,
> disposition, and a one-line reason — for A the requirement you could not find, for B the
> smell, for C the requirement that is genuinely untested. **A surviving mutant is never on
> its own a justification for a new test**; if you cannot name the requirement, it is route A.
> **Propose only — change no files.** Report the table and nothing else. Under 400 words.

The no-edit constraint is the axis's whole shape. As a review it returns a table for a human
to approve, exactly as the other two axes return findings; applying the dispositions is
separate work, governed by §4's gate.
