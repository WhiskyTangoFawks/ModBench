using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>One plugin's record as the override stack carries it.</summary>
internal static class ProjectedReads
{
    /// <summary>The committed state of one plugin's record, which the override stack carries beside
    /// its effective state; null when the plugin holds no effective row for it.</summary>
    internal static RecordDocument? HeadDocument(this IRecordReads reads, string formKey, PluginAddress plugin) =>
        reads.GetOverrideStack(formKey)?.Entries
            .SingleOrDefault(e => e.Plugin.Equals(plugin))?.Head;

    internal static OverrideStackEntry? StackEntry(this IRecordReads reads, string formKey, PluginAddress plugin) =>
        reads.GetOverrideStack(formKey)?.Entries.SingleOrDefault(e => e.Plugin.Equals(plugin));
}
