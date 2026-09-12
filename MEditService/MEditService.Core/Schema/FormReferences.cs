using System.Collections.Concurrent;
using System.Text.Json;

namespace MEditService.Core.Schema;

/// <summary>One link a document holds: the record it names, and the member path that names it.</summary>
internal readonly record struct FormReference(string TargetFormKey, string FieldPath);

/// <summary>Which FormKeys a document references, answered by the schema for its record type
/// (ADR-0014 invariant 5). Over the document and the schema alone: no index, no plugin, no path
/// on disk.</summary>
internal static class FormReferences
{
    /// <summary>Every link the document holds, in the schema's column order. A target named at two
    /// members is answered twice, once under each path, because a path is what names it.</summary>
    internal static List<FormReference> Collect(JsonElement document, RecordTableSchema schema)
    {
        var refs = new List<FormReference>();
        foreach (var col in schema.RecordColumns)
            Walk(col, document, (path, fk) => refs.Add(new FormReference(fk, path)));
        return refs;
    }

    private delegate void RefVisitor(string fieldPath, string targetFormKey);

    // Every reference one column of the document holds, read off the document by the column's own
    // path.
    private static void Walk(ColumnSpec col, JsonElement root, RefVisitor visitor)
    {
        // A column whose metadata holds no formKey leaf is skipped without being read, decided once
        // per ColumnSpec since the schema is built at startup.
        var (meta, carriesFormKeys) = Plans.GetOrAdd(col, static c =>
        {
            var m = c.ToFieldMetadata();
            return (m, CarriesFormKeys(m));
        });
        if (!carriesFormKeys) return;
        Walk(DocumentNodes.VariantFor(meta, root), DocumentNodes.At(root, col.PropertyName), col.Name,
            (path, raw, _, _) => { if (IsRealRef(raw)) visitor(path, raw!); });
    }

    // Keyed by reference: ColumnSpec is a record whose value equality would walk its whole member
    // tree on each lookup, and the schema's own instances are the only ones here.
    private static readonly ConcurrentDictionary<ColumnSpec, (FieldMetadata Meta, bool CarriesFormKeys)> Plans =
        new(ReferenceEqualityComparer.Instance);

    internal static bool CarriesFormKeys(FieldMetadata meta) =>
        meta.Type switch
        {
            "formKey" => true,
            "struct" => meta.Fields?.Any(CarriesFormKeys) == true,
            "array" => meta.ElementType != null && CarriesFormKeys(meta.ElementType),
            _ => false,
        }
        || meta.Variants?.Values.Any(CarriesFormKeys) == true;

    /// <summary>Visits every formKey leaf under the metadata, an omitted member as null: a stored
    /// document omits an unset link, which is a fact about the record.</summary>
    internal static void Walk(
        FieldMetadata meta, JsonElement? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf)
    {
        if (meta.Type == "formKey")
        {
            onFormKeyLeaf(path, ExtractString(value), meta.AllowsNull, meta.ValidFormKeyTypes);
            return;
        }

        if (meta.Type == "struct" && meta.Fields != null) WalkStruct(meta, value, path, onFormKeyLeaf);
        else if (meta.Type == "array" && meta.ElementType != null) WalkArray(meta, value, path, onFormKeyLeaf);
    }

    private static void WalkStruct(
        FieldMetadata meta, JsonElement? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf)
    {
        if (value is not { ValueKind: JsonValueKind.Object } obj) return;
        var idle = IdleMembers(meta.Fields!, obj);
        foreach (var field in meta.Fields!)
        {
            if (idle?.Contains(field.Name) == true) continue;
            var present = obj.TryGetProperty(field.Name, out var prop);
            JsonElement? member = null;
            if (present && prop.ValueKind != JsonValueKind.Null) member = prop;
            else if (field.Default is { } declared) member = JsonSerializer.SerializeToElement(declared);
            Walk(DocumentNodes.VariantFor(field, obj), member, path.Length > 0 ? $"{path}.{field.Name}" : field.Name, onFormKeyLeaf);
        }
    }

    // Mutagen aliases a condition's number and record parameters onto the same four bytes, so an
    // idle parameter slot is not walked: a quest-stage index would otherwise be filed as a
    // reference to whatever record holds that FormID.
    private static HashSet<string>? IdleMembers(IReadOnlyList<FieldMetadata> fields, JsonElement obj)
    {
        HashSet<string>? idle = null;
        foreach (var governing in fields)
        {
            if (governing.SiblingsInUse is not { } byValue) continue;

            var inUse = obj.TryGetProperty(governing.Name, out var current)
                && current.ValueKind == JsonValueKind.String
                && byValue.TryGetValue(current.GetString()!, out var named)
                    ? named
                    : [];
            idle ??= new(StringComparer.Ordinal);
            foreach (var member in byValue.Values.SelectMany(m => m))
                if (!inUse.Contains(member)) idle.Add(member);
        }
        return idle;
    }

    private static void WalkArray(
        FieldMetadata meta, JsonElement? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf)
    {
        if (value is not { ValueKind: JsonValueKind.Array } array) return;
        var idx = 0;
        foreach (var elem in array.EnumerateArray())
            Walk(meta.ElementType!, elem, $"{path}[{idx++}]", onFormKeyLeaf);
    }

    private static bool IsRealRef(string? s) => s is not null && s != "Null";

    internal static string? ExtractString(object? raw) => raw switch
    {
        string str => str,
        JsonElement { ValueKind: JsonValueKind.String } je => je.GetString(),
        _ => null
    };
}
