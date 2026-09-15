using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;

namespace MEditService.Tests;

/// <summary>Http's forced-plugins door, reimplemented from the same Mutagen calls: that door lives
/// in MEditService.Http, which this box does not reference.</summary>
internal static class IndexReconcile
{
    internal static LoadOrderHolder Reconcile(
        this IndexProjector index, LoadOrderHolder holder, string gameDirectory,
        IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease, string? instanceRoot = null)
    {
        var snapshot = new LoadOrderSnapshot(gameDirectory, instanceRoot, gameRelease, Prepend(gameDirectory, gameRelease, plugins));
        holder.Apply(snapshot);
        index.Reconcile(snapshot);
        return holder;
    }

    private static IReadOnlyList<RegisteredCopy> Prepend(
        string gameDirectory, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries)
    {
        var names = ForcedNames(gameDirectory, gameRelease);
        var forcedNames = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);

        var forced = names
            .Select((name, i) => new RegisteredCopy(
                name, PluginOrigin.DataDirectory, Path.Combine(gameDirectory, name), i, Enabled: true,
                Winning: true, IsForced: true))
            .ToList();

        return
        [
            .. forced,
            .. SnapshotCopies.Of(entries).Where(c => !forcedNames.Contains(c.Name)),
        ];
    }

    private static IReadOnlyList<string> ForcedNames(string gameDirectory, GameRelease gameRelease) =>
        [.. ImplicitNames(gameDirectory, gameRelease)
            .Concat(CreationClubNames(gameDirectory, gameRelease))
            .Distinct(StringComparer.OrdinalIgnoreCase)];

    private static List<string> ImplicitNames(string folder, GameRelease gameRelease) =>
        [.. Implicits.Get(gameRelease).Listings
            .Select(k => k.FileName.ToString())
            .Where(name => File.Exists(Path.Combine(folder, name)))];

    private static List<string> CreationClubNames(string folder, GameRelease gameRelease)
    {
        var cccPath = CreationClubListings.GetListingsPath(gameRelease.ToCategory(), folder);
        if (cccPath is not { } path || !File.Exists(path.Path)) return [];

        return [.. CreationClubListings.LoadOrderListingsFromPath(path, folder).Select(l => l.FileName.ToString())];
    }
}
