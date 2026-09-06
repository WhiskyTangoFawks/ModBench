using System.Collections.Concurrent;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

internal static class FormRefPathBuilder
{
    public delegate void RefVisitor(string fieldPath, string targetFormKey);

    /// <summary>Every reference one column of <paramref name="root"/> holds, read off the document
    /// itself by the column's own path.</summary>
    public static void Walk(ColumnSpec col, JsonElement root, RefVisitor visitor)
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

    /// <summary>Visits every formKey leaf under the metadata. absentMeansNull: an omitted member is
    /// visited as null, since a stored document omits an unset link; without it, skipped, since a
    /// write payload asserts nothing about members it omits.</summary>
    internal static void Walk(
        FieldMetadata meta, JsonElement? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf,
        bool absentMeansNull = true)
    {
        if (meta.Type == "formKey")
        {
            onFormKeyLeaf(path, ExtractString(value), meta.AllowsNull, meta.ValidFormKeyTypes);
            return;
        }

        if (meta.Type == "struct" && meta.Fields != null) WalkStruct(meta, value, path, onFormKeyLeaf, absentMeansNull);
        else if (meta.Type == "array" && meta.ElementType != null) WalkArray(meta, value, path, onFormKeyLeaf, absentMeansNull);
    }

    private static void WalkStruct(
        FieldMetadata meta, JsonElement? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf, bool absentMeansNull)
    {
        if (value is not { ValueKind: JsonValueKind.Object } obj) return;
        var idle = IdleMembers(meta.Fields!, obj);
        foreach (var field in meta.Fields!)
        {
            if (idle?.Contains(field.Name) == true) continue;
            var present = obj.TryGetProperty(field.Name, out var prop);
            if (!present && !absentMeansNull) continue;
            JsonElement? member = null;
            if (present && prop.ValueKind != JsonValueKind.Null) member = prop;
            else if (field.Default is { } declared) member = JsonSerializer.SerializeToElement(declared);
            Walk(DocumentNodes.VariantFor(field, obj), member, path.Length > 0 ? $"{path}.{field.Name}" : field.Name, onFormKeyLeaf, absentMeansNull);
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
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf, bool absentMeansNull)
    {
        if (value is not { ValueKind: JsonValueKind.Array } array) return;
        var idx = 0;
        foreach (var elem in array.EnumerateArray())
            Walk(meta.ElementType!, elem, $"{path}[{idx++}]", onFormKeyLeaf, absentMeansNull);
    }

    private static bool IsRealRef(string? s) => s is not null && s != "Null";

    internal static string? ExtractString(object? raw) => raw switch
    {
        string str => str,
        JsonElement { ValueKind: JsonValueKind.String } je => je.GetString(),
        _ => null
    };
}
