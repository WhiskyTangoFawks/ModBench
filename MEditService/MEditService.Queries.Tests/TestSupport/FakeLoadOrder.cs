using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>A <see cref="LoadOrderHolder"/> carrying exactly the plugins a test names — the kernel
/// half of a Queries test that needs no Index at all.</summary>
internal static class FakeLoadOrder
{
    internal static LoadOrderHolder Of(GameRelease release, params LoadOrderEntry[] plugins)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(@"C:\Games\Fallout4\Data", null, release, plugins));
        return holder;
    }
}
