# instanceAdapter

Instance adapter. A repository, the one box that reads or writes the instance: the mod manager's
configuration, the profiles, the mods and their order, the plugin order and the downloaded files.
MO2 is one implementation of it, and the only code that names MO2. It answers parsed reads, takes
changes in domain words, and signals that the instance changed. It hides the layout, every path
function, the watch, the manager's file formats with their codecs and splices, and whole-file
writes. `plugins.txt`'s format is the game's, and its codec is the kernel's Load-order file codec.
It reads which game the instance is for and where that game is. It writes no deployment, which is
deploy's.

- Every read treats only ENOENT (`errnoCode(err) === 'ENOENT'`) as empty and rethrows the rest. A
  bare `catch` publishes a permission error as an empty field, where failing the read keeps the
  Instance loader's last value.
