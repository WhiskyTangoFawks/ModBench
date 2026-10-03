# Http.Tests

- A test here proves the wire: one test per status mapping, and one per gesture end to end. The behaviour behind it has its test in the box that owns it.
- A test that only reads shares a loaded host through `LoadedApiFixture`. A test that writes, or needs a load order of its own, takes its own host through `HostedTests`.
- A scan that reads more than one project's source lives in `Architecture/`, which the gate runs on every backend change.
- A removal is proved by the build; each test asserts what the code does.
