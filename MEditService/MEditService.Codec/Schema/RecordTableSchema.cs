using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>A member the document never spells: the flag FlagName of the flags member at BackingPath.</summary>
public sealed record SyntheticBit(string BackingPath, string FlagName);

/// <summary>One column of a record table: the member's own spec, plus whether a document that
/// omits it means null (AbsentIsNull) rather than the default. A column refuses writes only by
/// naming ReadOnlyReason; the codec decides the rest.</summary>
public sealed record ColumnSpec(
    FieldMetadata Field,
    // The JSON path from the document root, dotted where the document nests the member (the
    // header's "ModHeader.Author"); the same as Name for every record column.
    string PropertyName,
    bool AbsentIsNull = false,
    SyntheticBit? Synthetic = null)
{
    /// <summary>The document's other spellings of this column's value, which the reader takes over
    /// it, so a write clears them.</summary>
    internal IReadOnlyList<string> Aliases { get; init; } = [];

    /// <summary>The document's own member name, which is the wire name and the view column name.</summary>
    public string Name => Field.Name;

    /// <summary>The wire's own name for the leaf kind.</summary>
    public string ApiType => Field.Type;
}

public sealed class RecordTableSchema
{
    internal RecordTableSchema(Type recordType) => RecordType = recordType;

    public required string TableName { get; init; }
    internal Type RecordType { get; }
    public required IReadOnlyList<ColumnSpec> RecordColumns { get; init; }

    /// <summary>The xEdit display name ("Activator" for <c>acti</c>); <see cref="TableName"/> stays
    /// the key everywhere else.</summary>
    internal string DisplayName => RecordDisplayNames.For(TableName);

    /// <summary>True for the plugin header, whose document is the whole mod's root RecordData.json
    /// rather than a major record's, so its columns sit under a nested path and it carries no
    /// record-header flags.</summary>
    public bool IsHeader { get; init; }

    /// <summary>Every column's node in <paramref name="document"/>, null where the document omits it,
    /// checked against what <paramref name="resolve"/> answers. No document holds a header's masters
    /// (ADR-0008), so their column reads null here.</summary>
    public List<FieldValue> FieldsOf(Document document, Func<string, ResolvedFormKey?> resolve, GameRelease release, bool indexed)
    {
        var root = document.Element;
        var fields = new List<FieldValue>(RecordColumns.Count);
        foreach (var col in RecordColumns)
        {
            // A synthetic member is the bit it stands for, read off the member the document spells.
            var value = col.Synthetic is { } bit
                ? JsonSerializer.SerializeToElement(SyntheticBits.IsSet(root, bit))
                : DocumentNodes.At(root, col.PropertyName);
            var meta = col.Field;
            // The check reads the shape this record's own class gives the column; the wire keeps the
            // column's whole metadata, variants included, so the editor can pick the same.
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(DocumentNodes.VariantFor(meta, root), value, resolve, release, indexed)));
        }
        return fields;
    }

    /// <summary>The records of this table the mod holds. Mutagen's enumeration by one placed-trap variant
    /// yields every variant a cell holds, so each record is checked. Lazy: Mutagen's group
    /// enumerator cannot resume after it throws.</summary>
    public IEnumerable<IMajorRecordGetter> RecordsIn(IModGetter mod) =>
        mod.EnumerateMajorRecords(RecordType, throwIfUnknown: false)
            .Where(record => RecordType.IsInstanceOfType(record) || RecordTypes.For(mod.GameRelease).RecordTypeOf(record) == TableName);

    // A ModHeader cannot carry the Partial Form flag.
    public bool IsPartialForm(Document document) => !IsHeader && document.IsPartialForm(RecordType);

    /// <summary>Each column holding a link whose check error <paramref name="text"/> carries, from the
    /// builder the record panel reads, so compile and the panel hold one definition of what is broken.</summary>
    public IEnumerable<(string Field, string Error)> LinkErrorsIn(
        string text, Func<string, ResolvedFormKey?> resolve, Func<string, string?> whyUnchecked, GameRelease release)
    {
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        foreach (var column in RecordColumns)
        {
            var meta = column.Field;
            if (!FormReferences.CarriesFormKeys(meta)) continue;
            if (CheckErrorBuilder.Build(
                    DocumentNodes.VariantFor(meta, root), DocumentNodes.At(root, column.PropertyName), resolve, release,
                    indexed: true, whyUnchecked) is { } error)
                yield return (meta.Name, error);
        }
    }

    /// <summary>Whether a record of this table can carry the Partial Form flag at all.</summary>
    public bool IsPartialFormable => PartialFormFlag.IsPartialFormable(RecordType);
}
