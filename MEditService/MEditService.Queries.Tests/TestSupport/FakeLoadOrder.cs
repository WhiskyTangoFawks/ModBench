using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>A <see cref="LoadOrderHolder"/> carrying exactly the plugins a test names — the kernel
/// half of a Queries test that needs no Index at all.</summary>
internal static class FakeLoadOrder
{
    internal static LoadOrderHolder Of(GameRelease release, params RegisteredPlugin[] plugins)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, release, plugins));
        return holder;
    }
}
