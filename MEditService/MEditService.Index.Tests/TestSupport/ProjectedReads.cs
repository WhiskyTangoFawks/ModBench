using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>ADR-0015 invariant 2: a write reaches the Index through the Indexer, never a push, so
/// a test that writes and then reads asks for the projection first. Validate is the channel with no
/// timer in it.</summary>
internal static class ProjectedReads
{
    internal static IRecordReads Projected(this Indexer index)
    {
        index.Settle();
        return index.RequireReads();
    }

    internal static void Settle(this Indexer index) => index.ValidateIndex(null);

    /// <summary>The committed state of one plugin's record, which the override stack carries beside
    /// its effective state; null when the plugin holds no effective row for it.</summary>
    internal static RecordDocument? HeadDocument(this IRecordReads reads, string formKey, PluginAddress plugin) =>
        reads.GetOverrideStack(formKey)?.Entries
            .SingleOrDefault(e => e.Plugin.Equals(plugin))?.Head;

    internal static OverrideStackEntry? StackEntry(this IRecordReads reads, string formKey, PluginAddress plugin) =>
        reads.GetOverrideStack(formKey)?.Entries.SingleOrDefault(e => e.Plugin.Equals(plugin));
}
