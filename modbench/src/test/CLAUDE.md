# Modbench tests

- A wait in a test is on a value: a fake clock advances time, or the delay is injected as zero. A check that something never happens waits for a later event ordered after it. Where no such event exists, it waits a fixed window.
- A rule ESLint holds is tested by ESLint.
- A removal is proved by the build; each test asserts what the code does.
