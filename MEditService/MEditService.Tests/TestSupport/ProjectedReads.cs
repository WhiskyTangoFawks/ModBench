using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>ADR-0046 invariant 4: a write reaches the Index through the projector and never through
/// a push, so a test that writes and then reads asks for the projection first. The reconcile is the
/// projector's channel with no timer in it; the Source watcher's own path is under test in
/// <c>Api.SourceWatchTests</c> and wherever a test awaits the projection sequence.</summary>
internal static class ProjectedReads
{
    /// <summary>The index, once every tracked copy's rows agree with the source tree again.</summary>
    internal static IRecordReads Projected(this ILoadOrderMirror mirror, RecordRef recordRef = RecordRef.Effective)
    {
        mirror.Settle();
        return mirror.Index!.At(recordRef);
    }

    /// <summary>The mirror's own reads — filter-aware and load-order-wide — behind the same
    /// projection.</summary>
    internal static IRecordReads SettledReads(this ILoadOrderMirror mirror)
    {
        mirror.Settle();
        return mirror.Reads!;
    }

    internal static void Settle(this ILoadOrderMirror mirror) => mirror.ValidateIndex(null);
}
