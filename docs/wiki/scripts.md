# Scripts

In a terminal, a notebook cell or a Run and Debug launch of a Modbench window, `import medit` reaches that window's instance with nothing to install, and the editor resolves the import. `help(medit)` lists its functions, and [scripts/medit.py](../../scripts/medit.py) is their source.

Any other language calls the HTTP API. A Modbench terminal sets `MEDIT_PORT`. The window that holds the record index writes it, with `PYTHONPATH`, to the file `python.envFile` names, `.env` at the instance root by default. The API's reference is served at `http://127.0.0.1:$MEDIT_PORT/swagger`.
