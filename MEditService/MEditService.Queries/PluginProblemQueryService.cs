using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Queries;

/// <summary>What is wrong in a record of a plugin's source, on the file that holds it: a reference
/// from the record <paramref name="FormKey"/> to <paramref name="TargetFormKey"/>, which no active
/// plugin holds.</summary>
public sealed record SourceProblem(string FormKey, string TargetFormKey, string SourceRelativePath, string Message);

/// <summary><paramref name="Failure"/> is set when the plugin's problems could not be placed on files,
/// so its empty <paramref name="Problems"/> is not a clean bill (ADR-0019).</summary>
public sealed record PluginProblems(PluginAddress Plugin, IReadOnlyList<SourceProblem> Problems, string? Failure = null);

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
        var held = snapshot.Active.ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        var missing = reads
            .GetReferencesToMissingRecordsOnFiles(plugin => held.GetValueOrDefault(plugin)?.Provider as PluginProvider.FromMod)
            .ToLookup(row => row.Reference.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Active
                .Where(plugin => tracked.Contains(plugin.Key))
                .Select(plugin => ProblemsOf(plugin.Key, snapshot.GameRelease, missing[plugin.Key].ToList())),
        ];
    }

    private static PluginProblems ProblemsOf(PluginAddress plugin, GameRelease release, List<MissingReferenceOnFile> rows) =>
        rows.FirstOrDefault(row => row.Failure is not null) is { } failed
            ? new(plugin, [], failed.Failure)
            : new(plugin, [.. rows.Select(row => Problem(row, release))]);

    private static SourceProblem Problem(MissingReferenceOnFile row, GameRelease release) =>
        new(row.Reference.FormKey,
            row.Reference.TargetFormKey,
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
