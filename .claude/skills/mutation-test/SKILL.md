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

**Route A — no requirement (code smells, `/code-review` vocabulary):**

- **Delete** (**Dead Code**, **Speculative Generality**) — guards impossible or
  unreachable state, or serves a need the spec doesn't have → remove it.
- **Simplify** (**Speculative Generality**) — the construct is stronger than the need
  (`?? ""` on a non-nullable) → rewrite so the mutation site ceases to exist.
- **Inline the middle man** (**Middle Man**) — the line only delegates onward → call
  the real target direct.
- **Unify the duplicate** (**Duplicated Code**) — the same logic lives elsewhere →
  extract one shared copy; coverage follows it.
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

### 4. Act and report

- Local fixes (delete, simplify, inline, unify, fix the assertion): apply directly,
  then rerun the tests.
- Architectural work (seam refactors, red-green cycles needing a new requirement):
  surface to the developer with the analysis and a recommendation.
- Accepts and equivalents: propose; batch for approval.

Close with a table: finding → disposition → applied / proposed.

**Done when** every disposition is either applied or handed to the developer with its
reasoning.

## Test-smell taxonomy

Vocabulary for route C — use these names so a mutation finding and a static-review
finding compose. Flag with concrete evidence from the test body.

- **mechanism-not-outcome** — asserts internal call counts, intermediate state, or
  private structure instead of observable behavior (`retries == 3`).
- **vacuous** — no assertion; only "does not throw"; or asserts a value it just set.
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
