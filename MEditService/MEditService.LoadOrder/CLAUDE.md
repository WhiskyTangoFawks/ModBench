# MEditService.LoadOrder

Load order state. Holds the snapshot Modbench sends: every plugin in the instance, with its path and what provides it, and the active plugins in load order. Every box below the drivers on the mEdit side reads it. It derives nothing: Mod Management decides which plugins are active (ADR-0013).
