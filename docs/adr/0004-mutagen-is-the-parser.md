# Mutagen is the parser

Mutagen is the only maintained parser with typed records for every supported Bethesda game, and it
is used as a library, never through a CLI. It is a C# NuGet package, so everything that touches a
plugin binary or the record index is C#: an ASP.NET Core minimal API on localhost that publishes an
OpenAPI spec. Because the backend is a standalone process behind an HTTP API, any language can
script it, and a script debugs as its own process. VS Code extensions are TypeScript, so the
extension and its webviews are TypeScript. The extension's API client is generated from the spec,
never written by hand, and a gate catches drift between the two.

## Alternatives rejected

- **Spriggit CLI or xedit-lib as the parser.** A process boundary or native interop, and a narrower
  interface than the library.
- **A custom binary parser.** No justification while Mutagen exists and covers every target game.
- **Python or Node.js for the backend.** Neither can call Mutagen directly. A layer in front of a
  C# service is a proxy with no benefit, and zEdit, which took the Node route, is abandoned.
