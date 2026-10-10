using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Index.Queries;

/// <summary>What is wrong in a plugin's source, on its file: a link at <paramref name="FieldPath"/> to
/// <paramref name="TargetFormKey"/>, which neither it nor an active plugin holds, or a file the read stopped at.</summary>
public sealed record SourceProblem(
    string? FormKey, string? TargetFormKey, string? FieldPath, string SourceRelativePath, string Message)
{
    internal static SourceProblem StoppedAt(SourceFileFailure failure) =>
        new(failure.FormKey, null, null, failure.SourceRelativePath, failure.Message);
}

/// <summary>Why a plugin's <see cref="PluginProblems.Problems"/> are not a clean bill (ADR-0019).</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ProblemsFailureKind
{
    /// <summary>Its links could not be placed on files; mEdit does not log this.</summary>
    Placement,
    /// <summary>Its rows are the last good read's; mEdit logs this once when it begins.</summary>
    LaterRead,
}

/// <summary><paramref name="Failure"/> and its <paramref name="FailureKind"/> are set when the plugin's
/// <paramref name="Problems"/> are not a clean bill (ADR-0019).</summary>
public sealed record PluginProblems(
    PluginAddress Plugin, IReadOnlyList<SourceProblem> Problems, string? Failure = null, ProblemsFailureKind? FailureKind = null);

/// <summary>The Problems panel's source, per tracked plugin, active or not. A plugin whose read
/// failed is answered with the files that stopped it, and the links of rows its tree gave.</summary>
public sealed class PluginProblemQueryService
{
    private readonly IQueryIndex _index;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;

    internal PluginProblemQueryService(IQueryIndex index, LoadOrderHolder loadOrder, ISourceAdapter source)
    {
        _index = index;
        _loadOrder = loadOrder;
        _source = source;
    }

    /// <summary>A plugin the index has not reached holds no record yet, so every link into it would
    /// read as a missing record.</summary>
    public Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems() => IndexAnswer.Of(ProblemsOfPlugins);

    private IReadOnlyList<PluginProblems> ProblemsOfPlugins()
    {
        var snapshot = _loadOrder.Require();
        var reads = _index.RequireWholeSetReads();
        var derivations = reads.GetDerivations();
        var stopped = _index.SourceFileFailures.ToLookup(failure => failure.Plugin, PluginAddress.Comparer);
        var held = snapshot.Plugins.ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        var missing = reads
            .GetReferencesToMissingRecordsOnFiles(plugin => held.GetValueOrDefault(plugin) is { } registered
                ? _source.Over(registered, snapshot.GameRelease)
                : null)
            .ToLookup(row => row.Reference.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Plugins
                .Where(plugin => derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom.IsTracked() || stopped.Contains(plugin.Key))
                .Select(plugin => ProblemsOf(
                    plugin.Key, snapshot.GameRelease, _index.LaterReadFailure(plugin.Key), [.. stopped[plugin.Key].Select(SourceProblem.StoppedAt)],
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
