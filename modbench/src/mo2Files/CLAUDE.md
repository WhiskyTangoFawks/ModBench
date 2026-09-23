# mo2Files

Instance adapter. A repository, the one box that reads or writes the instance: the mod manager's
configuration, the load order, the mods and the downloads. MO2 is one implementation of it, and the
only code that names MO2. It reads which game the instance is for and where that game is, and hides
the layout, the globs its watchers use and every path function; it writes no deployment, which is
deploy's.
