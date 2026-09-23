# MEditService.Codec

Codec + schema. Converts a record between its Mutagen object and its JSON document, the one record
model on the wire and on disk (ADR-0005), and builds the field schema from the Mutagen assembly.
Read by every core box and driven adapter on the mEdit side. The only path from an edit to a live
Mutagen object, and with the plugin adapter the only box that references the game assemblies.

- A schema fact reflection cannot answer is a row in `SchemaAnnotations.Tables` for its
  `GameCategory` (ADR-0005 invariant 4), never a type- or member-name test in `Schema/`'s walk.
  `Validate` fails schema generation on a row the assembly does not bear out; a name test fails
  nowhere and drifts silently.
