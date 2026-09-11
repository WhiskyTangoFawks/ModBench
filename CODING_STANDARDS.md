# Coding standards

A review checks these rules against every hunk of the diff. No gate holds them.
Each rule reads *tell* → *fix*. A tell is a hunk to question. A review reads
[modbench/CLAUDE.md](modbench/CLAUDE.md) and [MEditService/CLAUDE.md](MEditService/CLAUDE.md)
with this file.

## Comments and docs

- A comment explains what the code does. → Rename or restructure until the code says it.
  A comment states a constraint from outside the code.
- A comment contradicts the code beneath it. → Delete it.
- A comment inside a test. → Move what it says into the test's name or an assertion.

## Failures

A failure is data (ADR-0019) and a command returns its refusal (ADR-0014 rule 4). These
hold the seam between an exception and a result.

- A `throw` that a caller could catch and act on. → It is a refusal or a failure. Return it
  in the gesture's own carrier.
- A `throw` that stays. → It is an invariant violation, and its message names the invariant.

## Tests

Development is /tdd: a failing test, then the code that passes it, one slice at a time.
Mutation testing holds assertion strength. These are the marks a skipped loop leaves in a
diff.

- A hunk changes behaviour and no test in the diff covers it. → Name the hunk. Red comes
  before green.
- A test cannot fail. Its expected value is computed the way the code computes it, or it
  asserts only that a value exists or nothing threw, or it asserts what its own double was
  told to return. → Assert a known literal from the spec, or delete the test.
- A test asserts shape: a type, method or field exists, or a call returned an object. →
  Assert the outcome a caller observes, or delete it. The compiler holds shape.
- A test proves an absence: a removed method, a retired field, an old wire form. → Delete
  it. The compiler holds absence, and a refactor ships no tests.
- A test reaches past the seam: a private member, or a row read around the interface. →
  Move it to the seam and assert the outcome there.
- A refactor hunk arrives with an edit to the test of the same behaviour. → The test was
  coupled to the implementation. Rewrite it at the seam so the next refactor leaves it alone.
- A test repeats another test's assertions under a different name. → Keep one.
- A test name says which method runs. → Rename it to say which behaviour holds.
- A test contains a loop or a conditional. → Split it into one test per path.
- A port's test double is a mock that asserts calls or their order. → Replace it with a fake
  that honours the port's contract. Tests share the fake. The fake is the port's second
  adapter (ADR-0014 rule 2). A test asserts a call only when the call is the contract.

## Naming

- An identifier names a domain concept with a word other than the glossary's. → Use the term
  in [CONTEXT.md](CONTEXT.md).
- A hunk introduces a domain word the glossary lacks. → Surface to the developer for a decision.
