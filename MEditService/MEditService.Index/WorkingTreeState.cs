using System.Text.Json.Serialization;

namespace MEditService.Index;

// A tri-state rather than two booleans: the states are mutually exclusive. Deleted is absent
// because a working-tree-deleted record has no row to describe.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WorkingTreeState { None, Modified, Added }

internal static class WorkingTreeStates
{
    internal static string Stored(this WorkingTreeState state) => state.ToString().ToLowerInvariant();

    internal static WorkingTreeState FromStored(string stored) => Enum.Parse<WorkingTreeState>(stored, ignoreCase: true);
}
