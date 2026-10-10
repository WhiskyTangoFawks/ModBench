using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Index.Queries;

/// <summary>The Problems panel's source, per tracked plugin, active or not. A plugin whose read
/// failed is answered with the files that stopped it, and the links of rows its tree gave.</summary>
internal static class ProblemsPanel
{
    public static IReadOnlyList<PluginProblems> Of(Indexer index, IRecordReads reads, LoadOrderSnapshot snapshot, ISourceAdapter source)
    {
        var derivations = reads.GetDerivations();
        var stopped = index.SourceFileFailures.ToLookup(failure => failure.Plugin, PluginAddress.Comparer);
        var held = snapshot.Plugins.ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        var missing = reads
            .GetReferencesToMissingRecordsOnFiles(plugin => held.GetValueOrDefault(plugin) is { } registered
                ? source.Over(registered, snapshot.GameRelease)
                : null)
            .ToLookup(row => row.Reference.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Plugins
                .Where(plugin => derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom.IsTracked() || stopped.Contains(plugin.Key))
                .Select(plugin => ProblemsOf(
                    plugin.Key, snapshot.GameRelease, index.LaterReadFailure(plugin.Key), [.. stopped[plugin.Key].Select(SourceProblem.StoppedAt)],
                    // A binary's links are not its tree's, whose files the panel shows them on.
                    derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom == DerivedFrom.SourceTree ? [.. missing[plugin.Key]] : [])),
        ];
    }

    private static PluginProblems ProblemsOf(
        PluginAddress plugin, GameRelease release, IReadOnlyList<SourceFileFailure>? laterReadFailure, List<SourceProblem> stoppedAt,
        List<MissingReferenceOnFile> rows) =>
        FailureOf(laterReadFailure, rows) is var (failure, kind) && failure is not null
            ? new(plugin, stoppedAt, failure, kind)
            : new(plugin, [.. stoppedAt, .. rows.Select(row => Problem(row, release))]);

    private static SourceProblem Problem(MissingReferenceOnFile row, GameRelease release) =>
        new(row.Reference.FormKey,
            row.Reference.TargetFormKey,
            row.Reference.FieldPath,
            row.SourceRelativePath ?? throw new InvalidOperationException($"Expected {row.Reference.FormKey} to be placed."),
            $"{row.Reference.FieldPath}: {Unresolved(row.Reference.TargetFormKey, release)}");

    private static (string? Failure, ProblemsFailureKind? Kind) FailureOf(IReadOnlyList<SourceFileFailure>? laterReadFailure, List<MissingReferenceOnFile> rows)
    {
        if (laterReadFailure is { } files) return (string.Join(" ", files.Select(file => file.Message)), ProblemsFailureKind.LaterRead);
        var placement = rows.FirstOrDefault(row => row.Failure is not null)?.Failure;
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
