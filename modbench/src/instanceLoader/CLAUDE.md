# instanceLoader

Instance loader. Owns the instance value, which carries which game the instance is for. It builds
the value from the Instance adapter's parsed reads and nothing else, and rebuilds the whole value on
every change. It hides every watcher on the instance, armed on what the adapter says to watch, the
debounce, which file wins each path, and a downloaded file's status. A read failure keeps the last
value and publishes the reason beside it. It writes nothing.
