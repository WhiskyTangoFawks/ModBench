# Coding standards

A review checks these rules against every hunk of the diff. A rule a scan can check belongs to a gate, and leaves this file when its gate holds it. Each rule reads *tell* → *fix*. A tell is a hunk to question. A review reads [modbench/CLAUDE.md](modbench/CLAUDE.md) and [MEditService/CLAUDE.md](MEditService/CLAUDE.md) with this file.

## Comments and docs

- A comment explains what the code does. → Rename or restructure until the code says it. A comment states a constraint from outside the code.
- A comment contradicts the code beneath it. → Delete it.
- A comment restates an ADR, a spec or another comment. → Cite it. Keep only what the source does not say.

## Failures

A failure is data (ADR-0019) and a command returns its refusal (ADR-0019). These hold the seam between an exception and a result.

- A `throw` that a caller could catch and act on. → It is a refusal or a failure. Return it in the gesture's own carrier.
- A `throw` that stays. → It is an invariant violation, and its message names the invariant.

## Tests

Development is /tdd: a failing test, then the code that passes it, one slice at a time.

A test is where [spec/architecture/tests.md](spec/architecture/tests.md) puts it.

A test exists because it proves a rule. Coverage, of lines or of mutants, is never a target or a gate.

A box's test asserts what its own code decides.

A test at a higher box asserts the composition: one test per path through its wiring, and the outcome the user sees.

The cases of one rule are one table, an `it.each` or a `[Theory]` with a row per case.

An integration test drives a gesture as the user does: a command through VS Code, a request through HTTP. It treats the chain of boxes as a black box and observes its ends: the disk, the backend or its fake, the Output, the view and the HTTP response. It proves the wiring: one test per gesture end to end, and one per way a refusal reaches the user, such as a status mapping.

Tests share fixtures and fakes. A test uses the fake and the fixture that already exist before it builds its own.

These are the marks a skipped loop or a drifted layer leaves. A review looks for them in the tests of each box a diff touches, not only in the diff. A review reports a mark outside the diff, and the change does not fix it.

- A hunk changes behaviour and no test in the diff covers it. → Name the hunk. Red comes before green.
- A diff adds a test that another test already proves, or that proves all another does and more. → Keep the one that proves more.
- A diff deletes a test. → Its commit names the test that still proves the rule, or the mark that says nothing needs to. Check that the named test asserts the rule and still stands at the merge.
- A test cannot fail. Its expected value is computed the way the code computes it, or it asserts only that a value exists or nothing threw, or it asserts what its own double was told to return. → Assert a known literal from the spec, or delete the test.
- A test asserts shape: a type, method or field exists, or a call returned an object. → Assert the outcome a caller observes, or delete it. The compiler holds shape.
- A test proves an absence: a removed method, a retired field, an old wire form. → Delete it. The compiler holds absence.
- A test reaches past the seam: a private member, or a row read around the interface. → Move it to the seam and assert the outcome there.
- A refactor hunk arrives with an edit to the test of the same behaviour. → The test was coupled to the implementation. Rewrite it at the seam so the next refactor leaves it alone.
- A test name says which method runs. → Rename it to say which behaviour holds.
- A test contains a loop or a conditional. → Make each case a row of a table, or split it into one test per path.
- A port's test double is a mock that asserts calls or their order. → Replace it with a fake that honours the port's contract. Tests share the fake. The fake is the port's second adapter. A test asserts a call only when the call is the contract.
- A test asserts a case that a box beneath owns. → Delete it. If no test proves the wiring of that path, keep one.
- A responsibility moves to another box and its tests stay behind. → Move the tests with the code, and delete what the new owner already asserts.
- Several tests differ only in inputs and expected values. → Make them one table.
- A test file builds data that a shared fixture already builds. → Use the fixture.
- A test's input is larger than its rule needs: a real plugin where one record proves the rule, a modlist where two plugins do. → Use the smallest input that fails without the code.

## Naming

- An identifier names a domain concept with a word other than the glossary's. → Use the term in [GLOSSARY.md](spec/GLOSSARY.md).
- A hunk names a concept that neither GLOSSARY.md, the reference tool nor ordinary use names. → Describe it, and put the naming question to the developer.
