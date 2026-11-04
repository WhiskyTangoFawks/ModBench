using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A deleted reference keeps only its record header in plugin source, as a delete leaves it
/// (xedit.md, divergence 23): Mutagen reads the base record of one and writes none.</summary>
internal static class DeletedReferenceBases
{
    internal static IReadOnlyList<TreeFile> Dropped(IReadOnlyList<TreeFile> files, GameRelease release, SchemaReflector schemaReflector) =>
        [.. files.Select(file => file with { Content = Dropped(file.Content, release, schemaReflector) })];

    private static byte[] Dropped(byte[] owner, GameRelease release, SchemaReflector schemaReflector)
    {
        var types = RecordTypes.For(release);
        var schemas = schemaReflector.GetSchemas(release);
        var spans = ContainerDocumentEdits.EmbeddedChildSpansOf(owner, ownerRecordType: null, release).Values
            .SelectMany<EmbeddedChildSpan, (EmbeddedChildSpan Span, string Type)>(
                span => span.Discriminator is { } type && types.IsReference(type) ? [(span, type)] : [])
            .OrderByDescending(reference => reference.Span.Start)
            .ToList();
        if (spans.Count == 0) return owner;

        var text = Encoding.UTF8.GetString(owner);
        foreach (var (span, type) in spans)
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            var child = Document.Parse(ContainerDocumentEdits.ChildTextAt(bytes, span, release));
            if ((RecordFlagsWrite.HeldBy(child) & DeletedFlag.Bit) == 0) continue;

            var schema = schemas[types.RecordTypeNamed(type) ?? throw new InvalidOperationException($"Expected '{type}' to be a record type.")];
            var emptied = RecordEmptying.OfDeleted(child).Apply(child, schema, release, left: null);
            if (emptied.Text == child.Text) continue;

            var written = RecordTextCodec.RoundTrip(emptied.Text, release, type);
            text = ContainerDocumentEdits.WithChildReplaced(bytes, span, written);
        }
        return Encoding.UTF8.GetBytes(text);
    }
}
