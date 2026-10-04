namespace MEditService.Index;

public enum WorkingTreeState { None, Modified, Added }

internal static class WorkingTreeStates
{
    internal static string Stored(this WorkingTreeState state) => state.ToString().ToLowerInvariant();

    internal static WorkingTreeState FromStored(string stored) => Enum.Parse<WorkingTreeState>(stored, ignoreCase: true);
}
