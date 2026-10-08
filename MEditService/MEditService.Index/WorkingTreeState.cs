using System.Text.Json.Serialization;

namespace MEditService.Index;

// A tri-state rather than two booleans: the states are mutually exclusive. Deleted is absent
// because a working-tree-deleted record has no row to describe.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WorkingTreeState { None, Modified, Added }

/// <summary>The working-tree states beneath each tree row that has any, under the record filter
/// (common.md, story 11). A record's own state is on its listing; a block holds what its cells
/// hold.</summary>
public record WorkingTreeStatesBeneath(
    IReadOnlyList<WorkingTreeState> Plugin,
    IReadOnlyDictionary<string, IReadOnlyList<WorkingTreeState>> RecordTypes,
    IReadOnlyDictionary<string, IReadOnlyList<WorkingTreeState>> Records);

internal static class WorkingTreeStates
{
    internal static string Stored(this WorkingTreeState state) => state.ToString().ToLowerInvariant();

    internal static WorkingTreeState FromStored(string stored) => Enum.Parse<WorkingTreeState>(stored, ignoreCase: true);
}
