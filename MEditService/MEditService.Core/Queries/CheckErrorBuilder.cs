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
        FormRefPathBuilder.Walk(meta, value, "",
            (path, raw, allowsNull, validTypes) =>
            {
                var err = CheckScalar(raw, allowsNull, validTypes, getRecordType);
                if (err != null) entries.Add(path.Length > 0 ? $"{path}: {err}" : err);
            });
        return entries.Count > 0 ? string.Join("; ", entries) : null;
    }

    private static string? CheckScalar(
        string? value, bool allowsNull, IReadOnlyList<string> validTypes, Func<string, string?> getRecordType)
    {
        if (string.IsNullOrEmpty(value) || value == "Null")
            return allowsNull ? null : $"Found a NULL reference, expected: {string.Join(", ", validTypes)}";

        var resolvedType = getRecordType(value);
        if (resolvedType == null)
            return $"[{value}] <Error: Could not be resolved>";
        return validTypes.Count > 0 && !validTypes.Contains(resolvedType, StringComparer.OrdinalIgnoreCase)
            ? $"Found a {resolvedType} reference, expected: {string.Join(", ", validTypes)}"
            : null;
    }
}
