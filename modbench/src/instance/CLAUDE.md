# instance

Instance loader. Owns the instance value, which carries which game the instance is for: it builds
the value from disk and nothing else, and rebuilds the whole value on every change. It hides every
watcher on the instance's files, the debounce, the winner and participation rules, and a downloaded
file's status; a parse failure keeps the last value. It writes nothing.

- Every read in a recompute treats only ENOENT (`errnoCode(err) === 'ENOENT'`) as empty and
  rethrows the rest. A bare `catch` publishes a permission error as an empty field, where failing
  the recompute would keep the last value.
