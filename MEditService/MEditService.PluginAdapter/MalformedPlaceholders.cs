using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter;

/// <summary>Decompile and repair's baseline: the repaired plugin's tree with each malformed record, its own document or
/// embedded in its container's, a placeholder naming its diagnoses. A placeholder is a note, never a record.</summary>
internal static class MalformedPlaceholders
{
    internal sealed record Malformed(string FormKey, IReadOnlyList<string> Diagnoses);

    private const string MalformedMember = "Malformed";

    private static readonly JsonWriterOptions Indented = new() { Indented = true, NewLine = "\n", Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    internal static IReadOnlyList<TreeFile> In(IReadOnlyList<TreeFile> repaired, IReadOnlyList<Malformed> malformed, GameRelease release)
    {
        var tree = repaired.ToList();
        foreach (var record in malformed)
        {
            var at = tree.FindIndex(file => Carries(file, record.FormKey, release));
            if (at < 0) throw new InvalidOperationException($"Expected the repaired plugin's tree to carry {record.FormKey}, which its repair rewrote.");
            tree[at] = Carried.Of(tree[at], record.FormKey, release).With(Placeholder(record));
        }
        return tree;
    }

    private static string Placeholder(Malformed record)
    {
        using var text = new MemoryStream();
        using (var writer = new Utf8JsonWriter(text, Indented))
        {
            writer.WriteStartObject();
            writer.WriteString(RecordMembers.FormKey, record.FormKey);
            writer.WriteStartArray(MalformedMember);
            foreach (var diagnosis in record.Diagnoses) writer.WriteStringValue(diagnosis);
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(text.ToArray());
    }

    private static bool Carries(TreeFile file, string formKey, GameRelease release) =>
        DocumentTokens.FormKeysIn(file.Content, release)
            .Any(key => key.Position != FormKeyPosition.Other && FormKeyComparer.Instance.Equals(key.FormKey, formKey));

    private sealed record Carried(TreeFile Owner, EmbeddedChildSpan? Span)
    {
        internal static Carried Of(TreeFile file, string formKey, GameRelease release)
        {
            if (DocumentTokens.FormKeysIn(file.Content, release).FirstOrDefault(key => key.Position == FormKeyPosition.Root) is { } root
                && FormKeyComparer.Instance.Equals(root.FormKey, formKey))
                return new Carried(file, null);
            return new Carried(file, ContainerDocumentEdits.EmbeddedChildSpansOf(file.Content, ownerRecordType: null, release)[formKey]);
        }

        internal TreeFile With(string text) => Owner with
        {
            Content = Encoding.UTF8.GetBytes(Span is { } span ? ContainerDocumentEdits.WithChildNotedAs(Owner.Content, span, text) : text),
        };
    }
}
