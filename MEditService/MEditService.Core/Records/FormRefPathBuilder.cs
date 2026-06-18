using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

internal static class FormRefPathBuilder
{
    public delegate void RefVisitor(string fieldPath, string targetFormKey);

    public static void Walk(ColumnSpec col, Func<ColumnSpec, object?> getValue, RefVisitor visitor) =>
        Walk(col.ToFieldMetadata(), getValue(col), col.Name,
            (path, raw, _, _) => { if (IsRealRef(raw)) visitor(path, raw!); });

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
            if (obj.TryGetProperty(field.Name, out var prop))
                Walk(field, prop, path.Length > 0 ? $"{path}.{field.Name}" : field.Name, onFormKeyLeaf);
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
