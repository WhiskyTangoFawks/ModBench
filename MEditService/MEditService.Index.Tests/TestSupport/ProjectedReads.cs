using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>One plugin's record as the override stack carries it.</summary>
internal static class ProjectedReads
{
    internal static OverrideStackEntry? StackEntry(this IRecordReads reads, string formKey, PluginAddress plugin) =>
        reads.GetOverrideStack(formKey)?.Entries.SingleOrDefault(e => e.Plugin.Equals(plugin));
}
