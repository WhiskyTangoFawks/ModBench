using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Plugins;

/// <summary>The Plugin adapter's door onto one registered copy's own bytes, for a caller holding
/// the load order's record of where that copy is.</summary>
public static class ModImporters
{
    public static ILoadedMod Open(this IModImporter importer, RegisteredCopy copy, GameRelease release) =>
        importer.Import(new ModPath(copy.Path), release);
}
