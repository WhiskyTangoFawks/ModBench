# MEditService.LoadOrder

Load order state. Holds the snapshot Modbench sends: every plugin in the instance, with its path and what provides it, and the active plugins in load order. The core, the read model and the repositories on the mEdit side read it. It derives nothing: Mod Management decides which plugins are active (ADR-0013).
