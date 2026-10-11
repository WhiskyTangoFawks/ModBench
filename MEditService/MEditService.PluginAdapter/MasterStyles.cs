using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
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
            ? Cached(HeldPaths(MasterReferenceCollection.FromPath(plugin, loadOrder.GameRelease).Masters.Select(reference => reference.Master), loadOrder)
                .Select(path => KeyedMasterStyle.FromPath(path, loadOrder.GameRelease)))
            : null;

    /// <summary>Null for a game whose masters share one style. A master the load order does not hold is
    /// left out, so the write names it as missing, and one whose header does not read fails the answer.</summary>
    internal static Answer<IReadOnlyCache<IModMasterStyledGetter, ModKey>?, PluginFailure> Of(IEnumerable<ModKey> masters, LoadOrderSnapshot loadOrder)
    {
        if (!AreStyled(loadOrder)) return PluginAnswer.Of<IReadOnlyCache<IModMasterStyledGetter, ModKey>?>(null);
        var styles = new List<IModMasterStyledGetter>();
        foreach (var path in HeldPaths(masters, loadOrder))
        {
            if (!PluginFailure.Answer(() => KeyedMasterStyle.FromPath(path, loadOrder.GameRelease)).Holds(out var style, out var unread))
                return new PluginFailure.MasterUnreadable(path.ModKey, unread);
            styles.Add(style);
        }
        return PluginAnswer.Of<IReadOnlyCache<IModMasterStyledGetter, ModKey>?>(Cached(styles));
    }

    private static bool AreStyled(LoadOrderSnapshot loadOrder) => GameConstants.Get(loadOrder.GameRelease).SeparateMasterLoadOrders;

    private static IEnumerable<ModPath> HeldPaths(IEnumerable<ModKey> masters, LoadOrderSnapshot loadOrder)
    {
        var files = CopyOfEachFilename(loadOrder).ToDictionary(file => file.Name, file => file.Path, StringComparer.OrdinalIgnoreCase);
        return masters.Where(master => files.ContainsKey(master.FileName.String)).Select(master => new ModPath(master, files[master.FileName.String]));
    }

    private static Cache<IModMasterStyledGetter, ModKey> Cached(IEnumerable<IModMasterStyledGetter> styles)
    {
        var cache = new Cache<IModMasterStyledGetter, ModKey>(master => master.ModKey);
        cache.Set(styles);
        return cache;
    }

    /// <summary>A copy a line names stands for its filename; a plugin with no line is found after them.</summary>
    internal static IEnumerable<RegisteredPlugin> CopyOfEachFilename(LoadOrderSnapshot loadOrder) =>
        loadOrder.JudgedCopies().Concat(loadOrder.InJudgedOrder()).DistinctBy(file => file.Name, StringComparer.OrdinalIgnoreCase);
}
