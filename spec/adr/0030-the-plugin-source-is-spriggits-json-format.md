# The plugin source is Spriggit's JSON format

The plugin source is Spriggit's JSON format, and Modbench adds no customization of its own. Anyone with Spriggit then builds the plugin from it, such as a CI server or a teammate without Modbench, and the ecosystem keeps one text format for a plugin ([principles](../principles.md): Existing tools).

## Consequences

- The format's normalization is accepted. It touches what the Creation Kit scrambles on a save, which the game cannot depend on, and the plugin header, which the build manages.
- The contract is that Spriggit builds the same plugin from the text, not that Modbench writes Spriggit's bytes.
- Modbench reads only the Spriggit version it writes. A plugin source of another version moves through Spriggit's upgrade or a fresh decompile.

## Alternatives rejected

- Modbench's own format, with no normalization. It is faithful, but no other tool builds it, and the ecosystem gains a second text format.
- Modbench's own format, published as a Spriggit translation package. Spriggit builds it, but the ecosystem still gains a second text format.
- Spriggit's YAML format, for now. Users want JSON.
