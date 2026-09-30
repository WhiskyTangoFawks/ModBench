# instanceLoader

Instance loader. Owns the instance value, which names the game the instance is for. It builds the
value from the Instance adapter's parsed reads and nothing else, and rebuilds the whole value on
every change. It hides the debounce, which file wins each path, which plugins are active, and a
downloaded file's status. It recomputes on the adapter's signal, on activation and on refresh. The
snapshot names every plugin file in the instance, found by listing folders, never by `plugins.txt`
(ADR-0013, invariant 2). A read failure keeps the last value and publishes the reason beside it. It
writes nothing.
