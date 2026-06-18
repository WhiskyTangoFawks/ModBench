using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Core.Edits;

internal static class ReferenceValidator
{
    public static List<ReferenceValidationError> Validate(
        ColumnSpec col,
        Func<ColumnSpec, object?> getValue,
        Func<string, string?> getRecordType)
    {
        var errors = new List<ReferenceValidationError>();
        FormRefPathBuilder.Walk(col.ToFieldMetadata(), getValue(col), col.Name,
            (path, raw, allowsNull, validTypes) =>
                CheckValue(path, raw, allowsNull, validTypes, getRecordType, errors));
        return errors;
    }

    private static void CheckValue(
        string fieldPath, string? value, bool allowsNull,
        IReadOnlyList<string> validTypes, Func<string, string?> getRecordType,
        List<ReferenceValidationError> errors)
    {
        var isNull = string.IsNullOrEmpty(value) || value == "Null";
        if (isNull)
        {
            if (!allowsNull)
                errors.Add(new ReferenceValidationError(fieldPath, value ?? "Null", "null_not_allowed", validTypes));
            return;
        }

        var resolvedType = getRecordType(value!);
        if (resolvedType == null)
            errors.Add(new ReferenceValidationError(fieldPath, value!, "not_in_session", validTypes));
        else if (validTypes.Count > 0 && !validTypes.Contains(resolvedType, StringComparer.OrdinalIgnoreCase))
            errors.Add(new ReferenceValidationError(fieldPath, value!, "type_mismatch", validTypes));
    }
}
