# MEditService.LoadOrder

Load order state. Holds the load order Modbench sends, every registered plugin with its slot and its
enabled and winning flags, and answers which plugin wins each filename and which plugins participate. Read by every
core box and driven adapter on the mEdit side; the winner and participation rules live here and
nowhere else.