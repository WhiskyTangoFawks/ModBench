namespace MEditService.Core.Edits;

// The wire contract for a condition scalar-field edit path, mirroring VmadPath: "CTDA\<FieldPath>\
// <Index>\<SubField>" where FieldPath is the condition-owning field (e.g. "Conditions", matching
// ConditionOwner.FieldPath), Index is the condition's position within that list, and SubField names
// the edited part (Function / RunOn / Operator / Comparison / UseGlobal / Parameter\<n>). SubField
// itself may carry an embedded backslash (Parameter\<n>), so it's everything after the third
// separator rather than a fixed final segment.
public static class ConditionPath
{
    public const string Prefix = @"CTDA\";

    public static bool IsConditionPath(string path) =>
        path.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase);

    public static string Build(string fieldPath, int index, string subField) =>
        $@"CTDA\{fieldPath}\{index}\{subField}";

    public static string BuildParameter(string fieldPath, int index, int paramIndex) =>
        Build(fieldPath, index, $@"Parameter\{paramIndex}");

    public static bool TryParse(string path, out string fieldPath, out int index, out string subField)
    {
        fieldPath = "";
        index = -1;
        subField = "";
        if (!IsConditionPath(path)) return false;

        var rest = path[Prefix.Length..];
        var parts = rest.Split('\\', 3);
        if (parts.Length < 3) return false;
        if (parts[0].Length == 0 || parts[2].Length == 0) return false;
        if (!int.TryParse(parts[1], out var parsedIndex) || parsedIndex < 0) return false;

        fieldPath = parts[0];
        index = parsedIndex;
        subField = parts[2];
        return true;
    }

    // Parses a "Parameter\<n>" subField into its numeric slot index. False for any other subField.
    public static bool TryParseParameterIndex(string subField, out int paramIndex)
    {
        paramIndex = -1;
        const string prefix = @"Parameter\";
        if (!subField.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        return int.TryParse(subField[prefix.Length..], out paramIndex) && paramIndex >= 0;
    }
}
