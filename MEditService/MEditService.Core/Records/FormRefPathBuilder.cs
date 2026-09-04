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
        // A column whose metadata tree holds no formKey leaf cannot yield a ref, so its value
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

    // A struct column's own Extract answers the serialized VARCHAR the document stores, while a
    // struct *sub-field*'s answers a parsed JsonElement — the same two shapes ForEachElement already
    // accepts for an array, and for the same reason: this walk is asked of both levels.
    private static void WalkStruct(
        FieldMetadata meta, object? value, string path,
        Action<string, string?, bool, IReadOnlyList<string>> onFormKeyLeaf)
    {
        if (meta.Fields == null) return;
        if (value is string text)
        {
            using var doc = JsonDocument.Parse(text);
            WalkStruct(meta, doc.RootElement, path, onFormKeyLeaf);
            return;
        }

        if (value is not JsonElement { ValueKind: JsonValueKind.Object } obj) return;
        var idle = IdleMembers(meta.Fields, obj);
        foreach (var field in meta.Fields)
        {
            if (idle?.Contains(field.Name) == true) continue;
            if (obj.TryGetProperty(field.Name, out var prop))
                Walk(field, prop, path.Length > 0 ? $"{path}.{field.Name}" : field.Name, onFormKeyLeaf);
        }
    }

    /// <summary>The members this object's own governing values say carry no data, or null when
    /// nothing here governs anything — which is every struct but a condition's, so the walk pays no
    /// allocation for a concept two members use. See <see cref="FieldMetadata.SiblingsInUse"/>.
    /// An idle member is not walked at all, so an unused parameter slot is neither a reference nor a
    /// dangling one: Mutagen aliases a condition's number and record parameters onto the same four
    /// bytes, so a quest-stage index reads as a FormID and would otherwise be filed as a reference
    /// to whatever record happens to hold it.</summary>
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
