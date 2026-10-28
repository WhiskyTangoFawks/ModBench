# Deployment on Linux

Deploy writes the plugin order to the `plugins.txt` the game reads. On Linux the game runs in a Proton prefix, so deploy needs the prefix of your deployment folder's game. Steam makes that prefix for a non-Steam game. Set it up once for each deployment folder.

## Set up a deployment folder

1. Deploy once. The deployment folder then holds the game's program when the game folder is the deployment folder, or when a mod carries the program in its Root folder, such as a script extender's loader.
2. In Steam, choose Games, then Add a Non-Steam Game to My Library, and add the program in the deployment folder.
3. Open the game's Properties in Steam, then Compatibility. Turn on Force the use of a specific Steam Play compatibility tool, and choose a Proton version.
4. Launch the game from Steam once. Steam makes the prefix at `steamapps/compatdata/<id>/pfx` in one of its libraries, where `<id>` is the number Steam gives the non-Steam game.
5. Close the game and deploy again.

Deploy finds the non-Steam game by its program: the one shortcut in Steam that runs a program inside the deployment folder. Then deploy writes `plugins.txt` into that game's prefix, at `drive_c/users/steamuser/AppData/Local/<game>`. A `plugins.txt` that deploy did not write is renamed aside to `plugins.txt.modbench_renamed*`, not replaced. Purge puts it back.

## One prefix for each deployment folder

Each deployment folder has its own non-Steam game and its own prefix. The `plugins.txt` of one deployment folder does not change another's.

## When deploy writes no plugins.txt

Deploy still writes the other files. Its report says why it wrote no `plugins.txt`:

- `Modbench found no Steam at <folder>`: Steam is not at `~/.steam/steam`.
- `no non-Steam game in Steam runs a program in <deployment folder>`: add the program as in step 2.
- `several non-Steam games in Steam run programs in <deployment folder>`: the report names each program. Remove the shortcuts you do not use.
- `Steam's shortcut for <program> holds no appid`: Steam wrote the shortcut with no ID. Remove the shortcut and add it again.
- `Steam has made no prefix at <path> yet`: launch the game once as in step 4.
- `Steam cannot be read: <reason>`: a file of Steam's is damaged or not readable. The reason names the file.
