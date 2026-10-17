# Scripts

In a terminal of a Modbench window, `import medit` reaches that window's instance with nothing to install. `help(medit)` lists its functions, and [scripts/medit.py](../../scripts/medit.py) is their source.

Any other language calls the HTTP API. A Modbench terminal sets `MEDIT_PORT`, and the API's reference is served at `http://127.0.0.1:$MEDIT_PORT/swagger`.
