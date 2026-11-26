# Where a test goes

A test stands up a part of the [zoom-out](target-architecture.d2) and feeds it an input. Those two decide when it runs, and its cost never does: fixtures prove each rule at every branch, and before main, Windows proves what no fixture holds ([principles.md](../principles.md), Usable first).

| A test that stands up | on | runs at |
|---|---|---|
| nothing: it reads the source | the source | each edit where it can, and otherwise each branch |
| one box, at its seam | fixtures | each branch |
| one process, through its composition root | fixtures | each branch |
| the whole system | an instance | each merge to main |
| any part of the system | Windows | each merge to main |

- A behaviour's test is at the seam of the box whose code decides it.
- A branch runs the tests of each box it touches, and of every box that reaches that box through the references [layers.d2](layers.d2) governs.
- A test's ceiling is 1 s, so every run affords every test it selects. A gate fails a slower test, unless the developer approved it by name, with its reason. An approval lapses when its test runs under 1 s.
- Each box's tests have a time budget, on their summed time, and the other tests a gate runs share one. With the build, they bring a branch's gates to their verdict within 5 minutes, and a merge to main's within 10.
- The developer sets each budget.
- The ceiling and the budgets keep the developer's loop workable, so a gate enforces them on the machine that runs a branch's gates. A merge to main's Windows run, on its virtual machine, has one budget of its own: its whole wall time, and it never rises. It measures the run, not a test. A gate reports every other time and fails on none.
- A test that asserts a time or a memory figure cites the spec line that sets it. Without one it is a tool.
- A sweep over the user's data and a soak cannot run under the ceiling, so they are tools, not tests. They run at each release and when an installed game updates. A sweep's finding becomes a fixture with a test that fails on it, so every branch proves it from then on.
- A test whose result depends on the machine it runs on gates only on a real machine: a virtual machine has neither the user's hardware nor their game folder.
- `/verify` is the one entry to a merge to main, so every workflow meets the same tests.
- A test that skips at a merge to main fails it, and names the skip ([principles.md](../principles.md), Never silently wrong).
