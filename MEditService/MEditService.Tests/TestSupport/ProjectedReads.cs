using MEditService.LoadOrder;
using MEditService.Index;

namespace MEditService.Tests.TestSupport;

/// <summary>ADR-0015 invariant 2: a write reaches the Index through the projector, never a push, so
/// a test that writes and then reads asks for the projection first. The reconcile is the channel
/// with no timer in it.</summary>
internal static class ProjectedReads
{
    /// <summary>The index, once every tracked copy's rows agree with the source tree again.</summary>
    internal static IRecordReads Projected(this IndexProjector index, RecordRef recordRef = RecordRef.Effective)
    {
        index.Settle();
        return index.Store!.At(recordRef);
    }

    /// <summary>The Index's own reads — filter-aware and load-order-wide — behind the same
    /// projection.</summary>
    internal static IRecordReads SettledReads(this IndexProjector index)
    {
        index.Settle();
        return index.Reads!;
    }

    internal static void Settle(this IndexProjector index) => index.ValidateIndex(null);
}
