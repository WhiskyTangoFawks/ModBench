# instanceCommands

instance commands. The commands of the instance itself: switch profile hands the Instance adapter
the profile to select; put load order hands the mEdit client the load order snapshot; refresh asks
mEdit to drop and rebuild the index, and sends nothing. It hides nothing, and gets the instance
value as an argument. Not the Instance loader (src/instanceLoader/), which reads the instance and
never writes it.
