# install

install. Puts a mod's files into the instance: a new mod is staged and lands by one rename into
mods/; an upgrade replaces the folder's contents in place around .git, .gitignore and source/, so
the repository and the plugin source survive it. Installing from a downloaded file also marks that
file installed; a failed mark is a line in the Output, and the install stands. It hands the
Instance adapter every write, and adds nothing to mod order: mod sync picks up the new mod.
