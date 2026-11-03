using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.TestSupport;

/// <summary>A load order holding no plugin, for a read whose plugin has no master to find.</summary>
public static class EmptyLoadOrder
{
    public static LoadOrderSnapshot Of(GameRelease release, Language language = Language.English) =>
        new(string.Empty, null, release, [], [], [], [], [], [], language);
}
