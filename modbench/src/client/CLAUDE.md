# client

mEdit client. The extension's one port to mEdit: its commands and queries, its notifications, and
the mEdit process. It hides the HTTP adapter, the in-memory adapter and the process (ADR-0002); the
record panel's webview reads mEdit with its own client (ADR-0007).
