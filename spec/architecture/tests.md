# Where a test goes

A test stands up a part of the [zoom-out](target-architecture.d2) and feeds it an input. Those two decide when it runs, never what it costs: fixtures prove each rule at every branch, and before main the user's data and Windows prove what no fixture holds ([principles.md](../principles.md), Usable first).

| A test that stands up | on | runs at |
|---|---|---|
| nothing: it reads the source | the source | each edit where it can, and otherwise each branch |
| one box, at its seam | fixtures | each branch |
| one process, through its composition root | fixtures | each branch |
| the whole system | an instance | each merge to main |
| any part of the system | the user's data, or Windows | each merge to main |

- A behaviour's test is at the seam of the box whose code decides it.
- A branch runs the tests of each box it touches, and of every box that reaches that box through the references [layers.d2](layers.d2) governs.
- A test runs in well under a second, so every run affords every test it selects. A gate fails a slower test, unless the developer approved it by name, with its reason.
- A branch's gates reach their verdict within 5 minutes, and a merge to main's within 10 on each platform, build included. A gate fails a run that does not.
- A sweep over the user's data and a soak cannot run in a second, so they are tools, not tests. They run at each release and when an installed game updates. A sweep's finding becomes a fixture with a test that fails on it, so every branch proves it from then on.
- A test whose result depends on the machine it runs on gates only on a real machine: a virtual machine has neither the user's hardware nor their game folder.
- `/verify` is the one entry to a merge to main, so every workflow meets the same tests.
- A test that skips at a merge to main fails it, and names the skip ([principles.md](../principles.md), Never silently wrong).
