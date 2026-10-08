using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Index.Queries;

/// <summary>What is wrong in a plugin's source, on its file: a link at <paramref name="FieldPath"/> to
/// <paramref name="TargetFormKey"/>, which neither it nor an active plugin holds, or a file the read stopped at.</summary>
public sealed record SourceProblem(
    string? FormKey, string? TargetFormKey, string? FieldPath, string SourceRelativePath, string Message);

/// <summary><paramref name="Failure"/> is set when the plugin's links could not be placed on files, so
/// its <paramref name="Problems"/> are not a clean bill (ADR-0019).</summary>
public sealed record PluginProblems(PluginAddress Plugin, IReadOnlyList<SourceProblem> Problems, string? Failure = null);

/// <summary>The Problems panel's source, per tracked plugin, active or not. A plugin whose read
/// failed is answered with the files that stopped it, and the links of rows its tree gave.</summary>
public sealed class PluginProblemQueryService
{
    private readonly IQueryIndex _index;
    private readonly LoadOrderHolder _loadOrder;

    internal PluginProblemQueryService(IQueryIndex index, LoadOrderHolder loadOrder)
    {
        _index = index;
        _loadOrder = loadOrder;
    }

    /// <summary>Null until the index is ready: a plugin it has not reached holds no record yet, so
    /// every link into it would read as a missing record.</summary>
    public IReadOnlyList<PluginProblems>? GetProblems()
    {
        var snapshot = _loadOrder.Require();
        if (_index.Status.State != LoadOrderState.Ready) return null;

        var reads = _index.RequireReads();
        var derivations = reads.GetDerivations();
        var stopped = _index.SourceFileFailures.ToLookup(failure => failure.Plugin, PluginAddress.Comparer);
        var held = snapshot.Plugins.ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        var missing = reads
            .GetReferencesToMissingRecordsOnFiles(plugin => held.GetValueOrDefault(plugin)?.Provider as PluginProvider.FromMod)
            .ToLookup(row => row.Reference.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Plugins
                .Where(plugin => derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom.IsTracked() || stopped.Contains(plugin.Key))
                .Select(plugin => ProblemsOf(
                    plugin.Key, snapshot.GameRelease, [.. stopped[plugin.Key].Select(Problem)],
                    // A binary's links are not its tree's, whose files the panel shows them on.
                    derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom == DerivedFrom.SourceTree ? [.. missing[plugin.Key]] : [])),
        ];
    }

    private static PluginProblems ProblemsOf(
        PluginAddress plugin, GameRelease release, List<SourceProblem> stoppedAt, List<MissingReferenceOnFile> rows) =>
        rows.FirstOrDefault(row => row.Failure is not null) is { } failed
            ? new(plugin, stoppedAt, failed.Failure)
            : new(plugin, [.. stoppedAt, .. rows.Select(row => Problem(row, release))]);

    private static SourceProblem Problem(SourceFileFailure failure) =>
        new(failure.FormKey, null, null, failure.SourceRelativePath, failure.Message);

    private static SourceProblem Problem(MissingReferenceOnFile row, GameRelease release) =>
        new(row.Reference.FormKey,
            row.Reference.TargetFormKey,
            row.Reference.FieldPath,
            row.SourceRelativePath ?? throw new InvalidOperationException($"Expected {row.Reference.FormKey} to be placed."),
            $"{row.Reference.FieldPath}: {Unresolved(row.Reference.TargetFormKey, release)}");

    // The grid's and compile's own wording for a link no record answers, from the same builder.
    private static string Unresolved(string target, GameRelease release)
    {
        var link = new FieldMetadata("", "formKey", IsArray: false, [], []);
        using var value = JsonDocument.Parse(JsonSerializer.Serialize(target));
        return CheckErrorBuilder.Build(link, value.RootElement, _ => null, release)
            ?? throw new InvalidOperationException($"Expected {target}, which no record answers, to be an error.");
    }
}
