using MEditService.Index.Queries;

namespace MEditService.Index;

internal static class WorkingTreeStates
{
    internal static string Stored(this WorkingTreeState state) => state.ToString().ToLowerInvariant();

    internal static WorkingTreeState FromStored(string stored) => Enum.Parse<WorkingTreeState>(stored, ignoreCase: true);
}
