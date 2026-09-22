using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>ADR-0015 invariant 2: a write reaches the Index through the projector, never a push, so
/// a test that writes and then reads asks for the projection first. Validate is the channel with no
/// timer in it.</summary>
internal static class ProjectedReads
{
    internal static IRecordReads Projected(this IndexProjector index)
    {
        index.Settle();
        return index.RequireReads();
    }

    internal static void Settle(this IndexProjector index) => index.ValidateIndex(null);

    /// <summary>The committed state of one copy's record, which the override stack carries beside
    /// its effective state; null when the copy holds no effective row for it.</summary>
    internal static RecordDocument? HeadDocument(this IRecordReads reads, string formKey, PluginCopyKey plugin) =>
        reads.GetOverrideStack(formKey)?.Entries
            .SingleOrDefault(e => e.Plugin.Equals(plugin))?.Head;

    internal static OverrideStackEntry? StackEntry(this IRecordReads reads, string formKey, PluginCopyKey plugin) =>
        reads.GetOverrideStack(formKey)?.Entries.SingleOrDefault(e => e.Plugin.Equals(plugin));
}
