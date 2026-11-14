using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>What a name in a document is. A reference is a reference field's text, whatever it holds so far; a
/// declaration is a record's own <c>FormKey</c> member.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DocumentNameKind
{
    Declaration,
    Record,
    Plugin,
    Script,
    File,
    EditorId,
    Reference,
}

/// <summary>A name a document holds and its span: a record's FormKey with its quotes, any other name between them.
/// A file's carries its path in the Data folder, or why it has none.</summary>
public sealed record DocumentName(
    DocumentNameKind Kind,
    int Start,
    int End,
    string Value,
    string? Record,
    string? FieldPath,
    string? DataPath = null,
    string? Refusal = null,
    IReadOnlyList<string>? ValidFormKeyTypes = null);

/// <summary>The names a document's text holds, and where each sits (ADR-0028). A FormKey is read off the text alone;
/// the schema for its record's type names its scripts, files and references.</summary>
public static class DocumentNames
{
    // A FormKey's six-digit object ID and its delimiter come before its plugin's name.
    private const int PluginNameOffset = 7;

    // A name sits at an offset from From up to, not including, To.
    private readonly record struct Held(DocumentName Name, int From, int To);

    /// <summary>Every name, in text order; with <paramref name="at"/>, those that sit at that offset.
    /// <paramref name="columnsOf"/> answers the schema's columns for a record's FormKey, null where none does.</summary>
    public static IReadOnlyList<DocumentName> In(DocumentSpans document, Func<string, IReadOnlyList<ColumnSpec>?> columnsOf, int? at)
    {
        var held = new List<Held>();
        foreach (var node in document.Root?.SelfAndDescendants() ?? [])
            if (node.Text is { } text && CanonicalFormKey.OfLink(text) is { } formKey) held.AddRange(FormKeyNames(node, text, formKey));
        foreach (var record in document.Records) held.AddRange(RecordNames(record, columnsOf));
        return [.. held
            .Where(name => at is not { } offset || (offset >= name.From && offset < name.To))
            .OrderBy(name => name.Name.Start)
            .Select(name => name.Name)];
    }

    private static IEnumerable<Held> FormKeyNames(SpanNode node, string text, string formKey)
    {
        var (record, fieldPath) = Placed(node);
        yield return new(new(DocumentNameKind.Record, node.Start, node.End, formKey, record, fieldPath), node.Start, node.End);
        // Mutagen reads a FormKey past the whitespace around it.
        var (from, to) = (text.Length - text.TrimStart().Length + PluginNameOffset, text.TrimEnd().Length);
        var (start, end) = (node.Inside.Start + from, node.Inside.Start + to);
        yield return new(new(DocumentNameKind.Plugin, start, end, text[from..to], record, fieldPath), start, end + 1);
    }

    private static IEnumerable<Held> RecordNames(SpanNode record, Func<string, IReadOnlyList<ColumnSpec>?> columnsOf)
    {
        if (record.OwnFormKey is not { } formKey
            || record.Members?.FindLast(member => member.Name == RecordMembers.FormKey) is not { Value: { } value } own) yield break;
        yield return new(new(DocumentNameKind.Declaration, own.Start, value.End, formKey, formKey, RecordMembers.FormKey), own.Start, value.End);
        if (record.Member(RecordMembers.EditorId) is { Text: { } editorId } named)
            yield return Inside(named, new(DocumentNameKind.EditorId, 0, 0, editorId, formKey, RecordMembers.EditorId));
        if (columnsOf(formKey) is not { } columns) yield break;
        foreach (var name in SchemaNames(record, formKey, columns)) yield return name;
    }

    private static List<Held> SchemaNames(SpanNode record, string formKey, IReadOnlyList<ColumnSpec> columns)
    {
        var names = new List<Held>();
        var root = JsonSerializer.SerializeToElement(record.ToJsonNode());
        foreach (var col in columns)
        {
            FormReferences.WalkLeaves(DocumentNodes.VariantFor(col.Field, root), DocumentNodes.At(root, col.PropertyName), col.Name,
                leaf => leaf.Type == "formKey" || leaf.IsScriptName || leaf.AssetLinkType is not null,
                (leaf, path, _) =>
                {
                    if (record.At(path) is { Text: { } given } node && NameAt(leaf, given, formKey, path) is { } name)
                        names.Add(Inside(node, name));
                });
        }
        return names;
    }

    // A FormKey is a record's name, never a script's or a file's.
    private static DocumentName? NameAt(FieldMetadata leaf, string given, string record, string path)
    {
        if (leaf.Type == "formKey") return new(DocumentNameKind.Reference, 0, 0, given, record, path, ValidFormKeyTypes: leaf.ValidFormKeyTypes);
        if (given.Length == 0 || CanonicalFormKey.OfLink(given) is not null) return null;
        if (leaf.IsScriptName) return new(DocumentNameKind.Script, 0, 0, given, record, path);
        if (leaf.AssetLinkType is not { } linkType) return null;
        var placed = AssetLinks.DataPathOf(linkType, given);
        return new(DocumentNameKind.File, 0, 0, given, record, path, placed.DataPath,
            placed.DataPath is null ? placed.Refusal ?? $"{given} is no path its asset type holds." : null);
    }

    // A string still being typed reaches to the end of its text, where the cursor sits.
    private static Held Inside(SpanNode node, DocumentName name)
    {
        var (start, end) = node.Inside;
        return new(name with { Start = start, End = end }, node.Start, node.Closed ? node.End : node.End + 1);
    }

    private static (string? Record, string? FieldPath) Placed(SpanNode node) =>
        node.Parent?.Record is { } record ? (record.OwnFormKey, node.PathFrom(record)) : (null, null);
}
