using System.Text.Json;
using MEditService.Codec.Schema;
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
        var missing = reads.GetReferencesToMissingRecords().ToLookup(row => row.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Active
                .Where(plugin => tracked.Contains(plugin.Key))
                .Select(plugin => ProblemsOf(plugin, snapshot.GameRelease, missing[plugin.Key].ToList())),
        ];
    }

    // The index and the tree on disk are two reads: a file changed outside Modbench shows up in the
    // tree before the index re-reads it, so a row the tree cannot place fails its plugin, never the answer.
    private static PluginProblems ProblemsOf(RegisteredPlugin plugin, GameRelease release, List<MissingReference> rows)
    {
        if (rows.Count == 0) return new(plugin.Key, []);
        if (plugin.Provider is not PluginProvider.FromMod mod)
            return Failed(plugin, $"{plugin.Name} is tracked but no mod folder provides it.");

        var repository = SourceRepository.Over(mod, release);
        var problems = new List<SourceProblem>();
        foreach (var row in rows)
        {
            string? path;
            try
            {
                path = repository.RelativePathOf(plugin.Key, new RecordIdentity(row.FormKey, row.RecordType, row.EditorId));
            }
            catch (InvalidOperationException ex)
            {
                return Failed(plugin, $"{plugin.Name}'s source could not place {row.FormKey}: {ex.Message}");
            }
            // RelativePathOf answers a flat record's would-be path when its file is gone.
            if (path is null || !File.Exists(Path.Combine(mod.Folder, path))) return Failed(plugin, $"{plugin.Name}'s source holds no file for {row.FormKey}.");

            problems.Add(new SourceProblem(row.FormKey, path, $"{row.FieldPath}: {Unresolved(row.TargetFormKey, release)}"));
        }
        return new(plugin.Key, problems);
    }

    private static PluginProblems Failed(RegisteredPlugin plugin, string failure) => new(plugin.Key, [], failure);

    // The grid's and compile's own wording for a link no record answers, from the same builder.
    private static string Unresolved(string target, GameRelease release)
    {
        var link = new FieldMetadata("", "formKey", IsArray: false, [], []);
        using var value = JsonDocument.Parse(JsonSerializer.Serialize(target));
        return CheckErrorBuilder.Build(link, value.RootElement, _ => null, release)
            ?? throw new InvalidOperationException($"Expected {target}, which no record answers, to be an error.");
    }
}
