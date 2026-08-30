using System.Collections.Concurrent;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

internal static class FormRefPathBuilder
{
    public delegate void RefVisitor(string fieldPath, string targetFormKey);

    public static void Walk(ColumnSpec col, Func<ColumnSpec, object?> getValue, RefVisitor visitor)
    {
        // #113: a column whose metadata tree holds no formKey leaf cannot yield a ref, so its value
        // is never even extracted — for an array/struct column that extraction is a JSON serialize
        // (SchemaReflector) the walk below would only parse straight back, per record. Decided once
        // per ColumnSpec: the metadata is a pure function of the schema, which is built at startup.
        var (meta, carriesFormKeys) = Plans.GetOrAdd(col, static c =>
        {
            var m = c.ToFieldMetadata();
            return (m, CarriesFormKeys(m));
        });
        if (!carriesFormKeys) return;
        Walk(meta, getValue(col), col.Name,
            (path, raw, _, _) => { if (IsRealRef(raw)) visitor(path, raw!); });
    }

    // Keyed by reference: ColumnSpec is a record whose value equality would hash every member
    // (delegates included) on each lookup, and the schema's own instances are the only ones here.
    private static readonly ConcurrentDictionary<ColumnSpec, (FieldMetadata Meta, bool CarriesFormKeys)> Plans =
        new(ReferenceEqualityComparer.Instance);

    internal static bool CarriesFormKeys(FieldMetadata meta) =>
        meta.Type switch
        {
            "formKey" => true,
            "struct" => meta.Fields?.Any(CarriesFormKeys) == true,
            "array" => meta.ElementType != null && CarriesFormKeys(meta.ElementType),
            _ => false,
        };

    internal static void Walk(
        FieldMetadata meta, object? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf)
    {
        if (meta.Type == "formKey")
            onFormKeyLeaf(path, ExtractString(value), meta.AllowsNull, meta.ValidFormKeyTypes);
        else if (meta.Type == "struct")
            WalkStruct(meta, value, path, onFormKeyLeaf);
        else if (meta.Type == "array")
            WalkArray(meta, value, path, onFormKeyLeaf);
    }

    private static void WalkStruct(
        FieldMetadata meta, object? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf)
    {
        if (meta.Fields == null || value is not JsonElement { ValueKind: JsonValueKind.Object } obj) return;
        foreach (var field in meta.Fields)
        {
            if (obj.TryGetProperty(field.Name, out var prop))
                Walk(field, prop, path.Length > 0 ? $"{path}.{field.Name}" : field.Name, onFormKeyLeaf);
        }
    }

    private static void WalkArray(
        FieldMetadata meta, object? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf)
    {
        if (meta.ElementType == null) return;
        ForEachElement(value, (idx, elem) =>
            Walk(meta.ElementType, elem, $"{path}[{idx}]", onFormKeyLeaf));
    }

    private static bool IsRealRef(string? s) => s is not null && s != "Null";

    internal static string? ExtractString(object? raw) => raw switch
    {
        string str => str,
        JsonElement { ValueKind: JsonValueKind.String } je => je.GetString(),
        _ => null
    };

    internal static void ForEachElement(object? value, Action<int, JsonElement> callback)
    {
        if (value is string s)
        {
            using var doc = JsonDocument.Parse(s);
            Enumerate(doc.RootElement);
            return;
        }
        if (value is JsonElement { ValueKind: JsonValueKind.Array } je)
            Enumerate(je);

        void Enumerate(JsonElement arr)
        {
            var idx = 0;
            foreach (var elem in arr.EnumerateArray())
                callback(idx++, elem);
        }
    }
}
