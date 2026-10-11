using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Masters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.PluginAdapter;

/// <summary>Where a game's masters each carry a style (full, medium or light), Mutagen reads no FormID
/// out of a plugin without its masters' styles, and only each master's own header says it.</summary>
internal static class MasterStyles
{
    /// <summary>Null for a game whose masters share one style, or with no load order to find them in. A
    /// master the load order does not hold is left out, so the read names it as missing.</summary>
    internal static IReadOnlyCache<IModMasterStyledGetter, ModKey>? Of(ModPath plugin, GameRelease gameRelease, LoadOrderSnapshot? loadOrder)
    {
        if (loadOrder is null || !GameConstants.Get(gameRelease).SeparateMasterLoadOrders) return null;

        // The copy of each filename a judgement reads, else whichever copy is registered.
        var files = loadOrder.JudgedCopies().Concat(loadOrder.InJudgedOrder())
            .DistinctBy(file => file.Name, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(file => file.Name, file => file.Path, StringComparer.OrdinalIgnoreCase);
        var styles = new Cache<IModMasterStyledGetter, ModKey>(master => master.ModKey);
        foreach (var master in MasterReferenceCollection.FromPath(plugin, gameRelease).Masters.Select(reference => reference.Master))
        {
            if (files.TryGetValue(master.FileName.String, out var path))
                styles.Set(KeyedMasterStyle.FromPath(new ModPath(master, path), gameRelease));
        }
        return styles;
    }
}
