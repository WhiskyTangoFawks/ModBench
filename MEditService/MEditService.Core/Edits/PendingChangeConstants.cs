using System.Text.Json;

namespace MEditService.Core.Edits;

internal static class PendingChangeConstants
{
    internal const string CreateFieldPath = "$create";
    internal const string CreateChangeType = "create";
    internal const string DeleteFieldPath = "$delete";
    internal const string DeleteChangeType = "delete";
    internal const string FieldEditChangeType = "field_edit";
    internal const string RenumberChangeType = "renumber";
    internal const string RenumberFieldPath = "$renumber";
    internal const string VmadStructOpChangeType = "vmad_struct_op";

    internal static readonly JsonElement NullElement =
        JsonSerializer.SerializeToElement<object?>(null);
}
