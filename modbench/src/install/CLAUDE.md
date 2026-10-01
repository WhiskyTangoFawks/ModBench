# install

install. Puts a mod's files into the instance. It extracts a mod straight into mods/<name>, and a new install that fails removes its folder. An upgrade replaces the folder's contents in place, around .git, .gitignore and plugin-source/, so the repository and the plugin source survive it. Installing from a downloaded file also marks that file installed. A failed mark is a line in the Output, and the install stands. It hands the Instance adapter every write. It adds nothing to mod order, because mod sync picks up the new mod.
