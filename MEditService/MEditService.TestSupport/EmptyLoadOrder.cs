using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.TestSupport;

/// <summary>A load order holding no plugin, for a read whose plugin has no master to find.</summary>
public static class EmptyLoadOrder
{
    public static LoadOrderSnapshot Of(GameRelease release) => new(string.Empty, null, release, [], [], []);
}
