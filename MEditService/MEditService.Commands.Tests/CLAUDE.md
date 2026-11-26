# Commands.Tests

- A test that writes to a tracked tree edits its own copy of a template: `TrackedTemplates.CopyInto` or `WriteTracked` tracks each distinct mod once.
- A test here drives a handler. A test of the codec, an adapter or Mutagen alone lives in that box's tests.
