using System.Text.Json;
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

        if (col.ApiType == "formKey")
        {
            CheckValue(col.Name, FormRefPathBuilder.ExtractString(getValue(col)), col.AllowsNull, col.ValidFormKeyTypes, getRecordType, errors);
        }
        else if (col.ApiType == "array")
        {
            var elemMeta = col.ElementType;
            FormRefPathBuilder.ForEachElement(getValue(col), (idx, elem) =>
            {
                if (elemMeta?.Type == "formKey")
                {
                    CheckValue($"{col.Name}[{idx}]", FormRefPathBuilder.ExtractString(elem), elemMeta.AllowsNull, elemMeta.ValidFormKeyTypes, getRecordType, errors);
                }
                else if (elemMeta?.Type == "struct")
                {
                    if (elem.ValueKind != JsonValueKind.Object) return;
                    foreach (var subField in elemMeta.Fields ?? [])
                    {
                        if (subField.Type != "formKey") continue;
                        if (!elem.TryGetProperty(subField.Name, out var prop)) continue;
                        CheckValue($"{col.Name}[{idx}].{subField.Name}", FormRefPathBuilder.ExtractString(prop), subField.AllowsNull, subField.ValidFormKeyTypes, getRecordType, errors);
                    }
                }
            });
        }

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
