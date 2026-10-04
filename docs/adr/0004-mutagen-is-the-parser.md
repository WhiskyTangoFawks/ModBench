# Mutagen is the parser

Mutagen is the only maintained parser with typed records for every supported Bethesda game, and Modbench uses it as a library, never through a CLI. So everything that touches a plugin binary or the record index is C#, in a local service behind an HTTP API that any language can script.

## Alternatives rejected

- Spriggit CLI or xedit-lib as the parser. A process boundary or native interop, and a narrower interface than the library.
- A custom binary parser. No justification while Mutagen exists and covers every target game.
- Python or Node.js for the backend. Neither can call Mutagen directly. A layer in front of a C# service is a proxy with no benefit, and zEdit, which took the Node route, is abandoned.
