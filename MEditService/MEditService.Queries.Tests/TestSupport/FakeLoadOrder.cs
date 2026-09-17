using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Tests.TestSupport;

/// <summary>A <see cref="LoadOrderHolder"/> carrying exactly the copies a test names — the kernel
/// half of a Queries test that needs no Index at all.</summary>
internal static class FakeLoadOrder
{
    internal static LoadOrderHolder Of(GameRelease release, params RegisteredCopy[] copies)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, release, copies));
        return holder;
    }
}
