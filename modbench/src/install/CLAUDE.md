# install

install. Puts a mod's files into mods/: a new mod is staged and lands by one rename; an upgrade
replaces the folder's contents in place around its .git. Installing from a downloaded file also
marks that file installed in its `.meta`, for MO2; a failed mark fails nothing. It writes through
the Instance adapter and writes no modlist.txt line: modlist commands adopt the new folder.
