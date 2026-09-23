# MEditService.LoadOrder

Load order state. Holds the load order Modbench sends, every plugin copy with its slot and its
enabled and winning flags, and answers which copy wins and which copies participate. Read by every
core box and driven adapter on the mEdit side; the winner and participation rules live here and
nowhere else.