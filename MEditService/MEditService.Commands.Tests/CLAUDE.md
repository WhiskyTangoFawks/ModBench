# Commands.Tests

- A test that writes to a tracked tree edits its own copy of a template: `TrackedTemplates.CopyInto` or `WriteTracked` tracks each distinct mod once.
- A test over the committed real-data plugin runs each gesture once, on the smallest record that offers it.
- A test here drives a handler. A test of the codec, an adapter or Mutagen alone lives in that box's tests.
- A removal is proved by the build; each test asserts what the code does.
