using System.Text.Json;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

internal static class FormRefPathBuilder
{
    public delegate void RefVisitor(string fieldPath, string targetFormKey);

    public static void Walk(ColumnSpec col, Func<ColumnSpec, object?> getValue, RefVisitor visitor)
    {
        if (col.ApiType == "formKey")
        {
            var raw = getValue(col);
            var s = raw switch
            {
                string str => str,
                JsonElement { ValueKind: JsonValueKind.String } je => je.GetString(),
                _ => null
            };
            if (IsRealRef(s))
                visitor(col.Name, s!);
        }
        else if (col.ApiType == "array")
        {
            var elemType = col.ElementType?.Type;
            ForEachElement(getValue(col), (idx, elem) =>
            {
                if (elemType == "formKey")
                {
                    var s = elem.ValueKind == JsonValueKind.String ? elem.GetString() : null;
                    if (IsRealRef(s)) visitor($"{col.Name}[{idx}]", s!);
                }
                else if (elemType == "struct")
                {
                    if (elem.ValueKind != JsonValueKind.Object) return;
                    foreach (var subField in col.ElementType!.Fields ?? [])
                    {
                        if (subField.Type != "formKey") continue;
                        if (!elem.TryGetProperty(subField.Name, out var prop)) continue;
                        if (prop.ValueKind != JsonValueKind.String) continue;
                        var s = prop.GetString();
                        if (IsRealRef(s)) visitor($"{col.Name}[{idx}].{subField.Name}", s!);
                    }
                }
            });
        }
    }

    private static bool IsRealRef(string? s) => s is not null && s != "Null";

    private static void ForEachElement(object? value, Action<int, JsonElement> callback)
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
