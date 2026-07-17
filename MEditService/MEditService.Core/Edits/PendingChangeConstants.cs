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
    internal const string PlacementGroupPersistent = "persistent";
    internal const string PlacementGroupTemporary = "temporary";

    /// <summary>
    /// Change types that bring a FormKey into or out of existence. These are the ones that entangle
    /// other changes (ADR-0028 edge rule 1) and that dominate a derived group's operation.
    /// </summary>
    internal static bool IsLifecycle(string changeType) =>
        changeType is CreateChangeType or DeleteChangeType or RenumberChangeType;

    internal static readonly JsonElement NullElement =
        JsonSerializer.SerializeToElement<object?>(null);
}
