using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Queries;

/// <summary>The Problems panel's source, per compiled plugin, active or not. A plugin whose read
/// failed is answered with the files that stopped it, and the links of rows its tree gave.</summary>
internal static class ProblemsPanel
{
    public static IReadOnlyList<PluginProblems> Of(Indexer index, RelationReads reads, LoadOrderSnapshot snapshot, ISourceAdapter source)
    {
        var derivations = reads.GetDerivations();
        var stopped = index.SourceFileFailures.ToLookup(failure => failure.Plugin, PluginAddress.Comparer);
        var found = index.FileProblems.ToLookup(problem => problem.Plugin, PluginAddress.Comparer);
        var unreadable = UnreadableActive(index, snapshot);
        var holdingLinks = reads.GetSourcePluginsHoldingLinks();
        var held = snapshot.Plugins.ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        var missing = reads
            .GetReferencesToMissingRecordsOnFiles(plugin => held.GetValueOrDefault(plugin) is { } registered
                ? source.Over(registered, snapshot.GameRelease)
                : null)
            .ToLookup(row => row.Reference.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Plugins
                .Where(plugin => derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom.IsSourceMod() || stopped.Contains(plugin.Key))
                .Select(plugin =>
                {
                    var headerProblems = holdingLinks.Contains(plugin.Key) ? NoLinkChecked(plugin, unreadable, source.Over(plugin, snapshot.GameRelease)) : new HeaderProblems([], null);
                    return ProblemsOf(
                        plugin.Key, snapshot.GameRelease, index.LaterReadFailure(plugin.Key),
                        [.. stopped[plugin.Key].Select(SourceProblem.StoppedAt), .. Found(found[plugin.Key].Select(held => held.Problem), stopped[plugin.Key]), .. headerProblems.Problems],
                        [.. missing[plugin.Key]], unreadable, headerProblems.PlacementFailure);
                }),
        ];
    }

    // Only the load order's active plugins answer a link, and it holds one per file name (ADR-0012).
    private static Dictionary<string, string> UnreadableActive(Indexer index, LoadOrderSnapshot snapshot)
    {
        var active = snapshot.Active.Select(plugin => plugin.Key).ToHashSet(PluginAddress.Comparer);
        return index.UnreadableBinaries
            .Where(file => active.Contains(file.Plugin))
            .ToDictionary(file => file.Plugin.Name, file => file.Reason, StringComparer.OrdinalIgnoreCase);
    }

    // A file the read stopped at is already told by what stopped it.
    private static IEnumerable<SourceProblem> Found(IEnumerable<FileProblem> problems, IEnumerable<SourceFileFailure> stopped) =>
        problems
            .Where(problem => stopped.All(failure => failure.SourceRelativePath != problem.SourceRelativePath))
            .Select(problem => new SourceProblem(problem.FormKey, null, null, problem.SourceRelativePath, problem.Message));

    private static PluginProblems ProblemsOf(
        PluginAddress plugin, GameRelease release, IReadOnlyList<SourceFileFailure>? laterReadFailure, List<SourceProblem> stoppedAt,
        List<MissingReferenceOnFile> rows, IReadOnlyDictionary<string, string> unreadable, string? headerPlacementFailure) =>
        FailureOf(laterReadFailure, rows, headerPlacementFailure) is var (failure, kind) && failure is not null
            ? new(plugin, stoppedAt, failure, kind)
            : new(plugin, [.. stoppedAt, .. rows.Select(row => Problem(row, release, unreadable))]);

    private sealed record HeaderProblems(IReadOnlyList<SourceProblem> Problems, string? PlacementFailure);

    // Compile checks links against the active plugins, and says which it could not read, only when the plugin holds a link.
    private static HeaderProblems NoLinkChecked(RegisteredPlugin plugin, IReadOnlyDictionary<string, string> unreadable, ISourceRepositoryReads? repository)
    {
        var others = unreadable.Where(file => !file.Key.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (others.Count == 0) return new([], null);
        if (repository is null) return new([], $"{plugin.Name} is a compiled plugin but no mod folder provides it.");

        var header = PluginHeader.IdentityOf(plugin.Name);
        if (!repository.RelativePathOf(plugin.Key, header).Holds(out var path, out var failure))
            return new([], $"{plugin.Name}'s source could not place its header: {failure.Reason}");
        if (path is null) return new([], $"{plugin.Name}'s source holds no file for its header.");

        return new([.. others.Select(file => new SourceProblem(header.FormKey, null, null, path, UncheckedLinks.NoLinkInto(file.Key, file.Value)))], null);
    }

    private static SourceProblem Problem(MissingReferenceOnFile row, GameRelease release, IReadOnlyDictionary<string, string> unreadable)
    {
        var target = row.Reference.TargetFormKey;
        var notChecked = UncheckedLinks.Of(target, unreadable);
        return new(row.Reference.FormKey,
            target,
            row.Reference.FieldPath,
            row.SourceRelativePath ?? throw new InvalidOperationException($"Expected {row.Reference.FormKey} to be placed."),
            $"{row.Reference.FieldPath}: {notChecked?.Message ?? Unresolved(target, release)}",
            notChecked?.Plugin);
    }

    private static (string? Failure, ProblemsFailureKind? Kind) FailureOf(
        IReadOnlyList<SourceFileFailure>? laterReadFailure, List<MissingReferenceOnFile> rows, string? headerPlacementFailure)
    {
        if (laterReadFailure is { } files) return (string.Join(" ", files.Select(file => file.Message)), ProblemsFailureKind.LaterRead);
        var placement = rows.FirstOrDefault(row => row.Failure is not null)?.Failure ?? headerPlacementFailure;
        return (placement, placement is null ? null : ProblemsFailureKind.Placement);
    }

    // The grid's and compile's own wording for a link no record answers, from the same builder.
    private static string Unresolved(string target, GameRelease release)
    {
        var link = new FieldMetadata("", "formKey", IsArray: false, [], []);
        using var value = JsonDocument.Parse(JsonSerializer.Serialize(target));
        return CheckErrorBuilder.Build(link, value.RootElement, _ => null, release, indexed: true)
            ?? throw new InvalidOperationException($"Expected {target}, which no record answers, to be an error.");
    }
}
