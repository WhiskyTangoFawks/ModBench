# instanceCommands

instance commands. The commands of the instance itself. Switch profile hands the Instance adapter
the profile to select. Put load order hands the mEdit client the snapshot. Refresh asks mEdit to
drop and rebuild the index, and sends no snapshot. It hides nothing, and gets the instance value as
an argument. It is not the Instance loader (src/instanceLoader/), which reads the instance and
never writes it.
