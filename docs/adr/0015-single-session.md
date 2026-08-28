---
status: accepted
---

# One active session at a time

The backend holds a single active session (one game release + load order). Multiple concurrent
sessions are not supported.

A load order is specific to a game installation and represents a coherent state the game would
actually run. Allowing multiple concurrent sessions would require every query — record lookup,
conflict detection, FormKey resolution — to be scoped by session, adding significant complexity
for an edge case. If a user wants to compare two load orders, the workflow is: note what you
need, close the session, reload with the other load order.

Revisit if cross-load-order comparison becomes a meaningful use case.
