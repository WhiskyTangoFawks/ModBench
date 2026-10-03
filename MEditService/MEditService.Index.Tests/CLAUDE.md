# Index.Tests

- A test that only reads the cut-down plugin's index joins `CutDownPluginCollection`. A test that sets a filter or changes rows builds its own index.
- A real-data comparison reads each relation whole, one query per side (`IndexFiles.Rows`).
- A test here drives the index. A schema test that touches only the codec lives in Codec.Tests.
- A removal is proved by the build; each test asserts what the code does.
