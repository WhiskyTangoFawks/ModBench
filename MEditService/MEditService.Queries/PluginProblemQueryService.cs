using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Queries;

/// <summary>What is wrong in a record of a plugin's source, on the file that holds it: a reference to a
/// record no active plugin holds. <paramref name="FormKey"/> is the referring record's.</summary>
public sealed record SourceProblem(string FormKey, string SourceRelativePath, string Message);

public sealed record PluginProblems(PluginAddress Plugin, IReadOnlyList<SourceProblem> Problems);

/// <summary>The Problems panel's source, per tracked active plugin, in load order. A plugin that
/// holds no problem is answered with none, so a problem that cleared is told apart from a plugin
/// never asked.</summary>
public sealed class PluginProblemQueryService(IQueryIndex index, LoadOrderHolder loadOrder)
{
    /// <summary>Null until the index is ready: a plugin it has not reached holds no record yet, so
    /// every link into it would read as a missing record.</summary>
    public IReadOnlyList<PluginProblems>? GetProblems()
    {
        var snapshot = loadOrder.Require();
        if (index.Status.State != LoadOrderState.Ready) return null;

        var reads = index.RequireReads();
        var tracked = reads.GetTrackedPlugins();
        var missing = reads.GetReferencesToMissingRecords().ToLookup(row => row.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Active
                .Where(plugin => tracked.Contains(plugin.Key))
                .Select(plugin => new PluginProblems(plugin.Key, ProblemsOf(plugin, snapshot.GameRelease, missing[plugin.Key]))),
        ];
    }

    private static List<SourceProblem> ProblemsOf(
        RegisteredPlugin plugin, GameRelease release, IEnumerable<MissingReference> missing)
    {
        var rows = missing.ToList();
        if (rows.Count == 0) return [];

        var repository = plugin.Provider is PluginProvider.FromMod mod
            ? SourceRepository.Over(mod, release)
            : throw new InvalidOperationException($"Expected tracked {plugin.Name} to come from a mod folder.");
        return
        [
            .. rows.Select(row => new SourceProblem(
                row.FormKey,
                repository.RelativePathOf(plugin.Key, new RecordIdentity(row.FormKey, row.RecordType, row.EditorId))
                    ?? throw new InvalidOperationException($"Expected {plugin.Name}'s tree to hold {row.FormKey}."),
                $"{row.FieldPath}: {row.TargetFormKey} is held by no active plugin")),
        ];
    }
}
