using MEditService.LoadOrder;
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
    /// <summary>Null for a game whose masters share one style, or with no load order to find them in.</summary>
    /// <summary>A master whose header does not read fails the read naming that master.</summary>
    internal static IReadOnlyCache<IModMasterStyledGetter, ModKey>? Of(ModPath plugin, LoadOrderSnapshot? loadOrder) =>
        loadOrder is not null && GameConstants.Get(loadOrder.GameRelease).SeparateMasterLoadOrders
            ? Cached(HeldPaths(MasterReferenceCollection.FromPath(plugin, loadOrder.GameRelease).Masters.Select(reference => reference.Master), loadOrder)
                .Select(path => PluginFailure.Answer(() => KeyedMasterStyle.FromPath(path, loadOrder.GameRelease)).Holds(out var style, out var unread)
                    ? style
                    : throw new PluginFailureException(new PluginFailure.MasterUnreadable(path.ModKey, unread))))
            : null;

    /// <summary>A master the load order does not hold is left out, so the read names it as missing.</summary>
    internal static IReadOnlyCache<IModMasterStyledGetter, ModKey> Of(IEnumerable<ModKey> masters, LoadOrderSnapshot loadOrder) =>
        Cached(HeldPaths(masters, loadOrder).Select(path => KeyedMasterStyle.FromPath(path, loadOrder.GameRelease)));

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
