using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Masters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.PluginAdapter;

/// <summary>Where a game's masters each carry a style (full, medium or light), Mutagen reads or writes no
/// FormID of a plugin without its masters' styles, and only each master's own header says it.</summary>
internal static class MasterStyles
{
    /// <summary>Null for a game whose masters share one style, or with no load order to find them in.</summary>
    internal static IReadOnlyCache<IModMasterStyledGetter, ModKey>? Of(ModPath plugin, LoadOrderSnapshot? loadOrder) =>
        loadOrder is not null && AreStyled(loadOrder)
            ? Read(MasterReferenceCollection.FromPath(plugin, loadOrder.GameRelease).Masters.Select(reference => reference.Master), loadOrder)
            : null;

    /// <summary>Null for a game whose masters share one style. A master the load order does not hold is
    /// left out, so the read or write names it as missing.</summary>
    internal static IReadOnlyCache<IModMasterStyledGetter, ModKey>? Of(IEnumerable<ModKey> masters, LoadOrderSnapshot loadOrder) =>
        AreStyled(loadOrder) ? Read(masters, loadOrder) : null;

    private static bool AreStyled(LoadOrderSnapshot loadOrder) => GameConstants.Get(loadOrder.GameRelease).SeparateMasterLoadOrders;

    private static Cache<IModMasterStyledGetter, ModKey> Read(IEnumerable<ModKey> masters, LoadOrderSnapshot loadOrder)
    {
        var files = CopyOfEachFilename(loadOrder).ToDictionary(file => file.Name, file => file.Path, StringComparer.OrdinalIgnoreCase);
        var styles = new Cache<IModMasterStyledGetter, ModKey>(master => master.ModKey);
        foreach (var master in masters)
        {
            if (files.TryGetValue(master.FileName.String, out var path))
                styles.Set(KeyedMasterStyle.FromPath(new ModPath(master, path), loadOrder.GameRelease));
        }
        return styles;
    }

    /// <summary>A copy a line names stands for its filename; a plugin with no line is found after them.</summary>
    internal static IEnumerable<RegisteredPlugin> CopyOfEachFilename(LoadOrderSnapshot loadOrder) =>
        loadOrder.JudgedCopies().Concat(loadOrder.InJudgedOrder()).DistinctBy(file => file.Name, StringComparer.OrdinalIgnoreCase);
}
