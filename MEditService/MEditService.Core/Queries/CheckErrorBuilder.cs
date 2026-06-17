using System.Text.Json;
using MEditService.Core.Records;

namespace MEditService.Core.Queries;

/// <summary>
/// Computes a TES5Edit-style diagnostic string for FormLink fields read from the record index —
/// mirrors TwbFormIDChecked.Check() in TES5Edit (wbInterface.pas:19850). Null when the value is clean.
/// </summary>
public static class CheckErrorBuilder
{
    public static string? Build(FieldMetadata meta, object? value, Func<string, string?> getRecordType)
    {
        var entries = new List<string>();
        Collect(meta, value, "", getRecordType, entries);
        return entries.Count > 0 ? string.Join("; ", entries) : null;
    }

    private static void Collect(
        FieldMetadata meta, object? value, string path,
        Func<string, string?> getRecordType, List<string> entries)
    {
        if (meta.Type == "formKey")
        {
            var err = CheckScalar(FormRefPathBuilder.ExtractString(value), meta.AllowsNull, meta.ValidFormKeyTypes, getRecordType);
            if (err != null) entries.Add(path.Length > 0 ? $"{path}: {err}" : err);
            return;
        }

        if (meta.Type == "struct" && meta.Fields != null &&
            value is JsonElement { ValueKind: JsonValueKind.Object } obj)
        {
            foreach (var field in meta.Fields)
                if (obj.TryGetProperty(field.Name, out var prop))
                    Collect(field, prop, path.Length > 0 ? $"{path}.{field.Name}" : field.Name, getRecordType, entries);
            return;
        }

        if (meta.Type == "array" && meta.ElementType != null &&
            value is JsonElement { ValueKind: JsonValueKind.Array } arr)
        {
            var idx = 0;
            foreach (var elem in arr.EnumerateArray())
            {
                Collect(meta.ElementType, elem, $"{path}[{idx}]", getRecordType, entries);
                idx++;
            }
        }
    }

    private static string? CheckScalar(
        string? value, bool allowsNull, IReadOnlyList<string> validTypes, Func<string, string?> getRecordType)
    {
        if (string.IsNullOrEmpty(value))
            return allowsNull ? null : $"Found a NULL reference, expected: {string.Join(", ", validTypes)}";

        var resolvedType = getRecordType(value);
        if (resolvedType == null)
            return $"[{value}] <Error: Could not be resolved>";
        if (validTypes.Count > 0 && !validTypes.Contains(resolvedType, StringComparer.OrdinalIgnoreCase))
            return $"Found a {resolvedType} reference, expected: {string.Join(", ", validTypes)}";

        return null;
    }
}
