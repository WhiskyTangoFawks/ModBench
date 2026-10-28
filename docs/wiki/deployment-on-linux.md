# Deployment on Linux

Deploy writes the plugin order to the `plugins.txt` the game reads. On Linux the game runs in a Proton prefix, so deploy needs the prefix of your deployment folder's game. Steam makes that prefix for a non-Steam game. Set it up once for each deployment folder.

## Set up a deployment folder

1. Deploy once, so the deployment folder holds the game's program.
2. In Steam, choose Games, then Add a Non-Steam Game to My Library, and add the program in the deployment folder. For a game with a script extender, add the extender's loader.
3. Open the game's Properties in Steam, then Compatibility. Turn on Force the use of a specific Steam Play compatibility tool, and choose a Proton version.
4. Launch the game from Steam once. Steam makes the prefix at `~/.steam/steam/steamapps/compatdata/<id>/pfx`, where `<id>` is the number Steam gives the non-Steam game.
5. Close the game and deploy again.

Deploy finds the non-Steam game by its program: the first one in Steam's shortcuts that runs a program inside the deployment folder. Then deploy writes `plugins.txt` into that game's prefix, at `drive_c/users/steamuser/AppData/Local/<game>`.

## One prefix for each deployment folder

Each deployment folder has its own non-Steam game and its own prefix. The `plugins.txt` of one deployment folder does not change another's.

## When deploy writes no plugins.txt

Deploy still writes the other files. Its report says why it wrote no `plugins.txt`:

- No Steam is found at `~/.steam/steam`.
- No non-Steam game in Steam runs a program in the deployment folder. Add it as in step 2.
- The game has no prefix yet. Launch it once as in step 4.
