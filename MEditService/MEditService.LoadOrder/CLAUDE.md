# MEditService.LoadOrder

Load order state. Holds the load order Modbench sends, every registered plugin with its slot and its
enabled and winning flags, and answers which plugin wins each filename and which plugins participate. Every core box
and driven adapter on the mEdit side reads it. The participation rule lives here and nowhere else.
The snapshot says which plugin wins each filename.
