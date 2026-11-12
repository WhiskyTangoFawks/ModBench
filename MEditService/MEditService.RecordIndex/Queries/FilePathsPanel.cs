using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>The file paths each compiled plugin's source names, with the file that holds each naming record. A record
/// whose paths <see cref="AssetPaths"/> refuses is told as unread, never dropped.</summary>
internal static class FilePathsPanel
{
    public static IReadOnlyList<PluginFilePaths> Of(
        Indexer index, RelationReads reads, LoadOrderSnapshot snapshot, ISourceAdapter source, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var derivations = reads.GetDerivations();
        var copies = reads.GetCopiesOfCompiledPlugins().ToLookup(copy => copy.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Plugins
                .Where(plugin => derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom.IsSourceMod())
                .Select(plugin => index.LaterReadFailure(plugin.Key) is { } stopped
                    ? new PluginFilePaths(plugin.Key, [], [], string.Join(" ", stopped.Select(file => file.Message)), ProblemsFailureKind.LaterRead)
                    : PathsOf(plugin, copies[plugin.Key], source.Over(plugin, snapshot.GameRelease), schemas)),
        ];
    }

    private static PluginFilePaths PathsOf(
        RegisteredPlugin plugin, IEnumerable<CopyHoldingText> copies, ISourceRepositoryReads? repository, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (repository is null) return Placement(plugin, $"{plugin.Name} is a compiled plugin but no mod folder provides it.");
        var paths = new List<NamedFilePath>();
        var unread = new List<string>();
        foreach (var copy in copies)
        {
            if (!schemas.TryGetValue(copy.RecordType, out var schema))
            {
                unread.Add($"{copy.FormKey}: mEdit has no schema for its record type {copy.RecordType}");
                continue;
            }
            var named = AssetPaths.Collect(copy.Body, schema.RecordColumns);
            unread.AddRange(named.Refusals.Select(refused => $"{copy.FormKey}: {refused.FieldPath}: {refused.Reason}"));
            if (named.Files.Count == 0) continue;
            var identity = new RecordIdentity(copy.FormKey, copy.RecordType, copy.EditorId);
            if (!repository.RelativePathOf(plugin.Key, identity).Holds(out var file, out var failure))
                return Placement(plugin, $"{plugin.Name}'s source could not place {copy.FormKey}: {failure?.Reason}");
            if (file is null) return Placement(plugin, $"{plugin.Name}'s source holds no file for {copy.FormKey}.");
            paths.AddRange(named.Files.Select(path => new NamedFilePath(copy.FormKey, path.FieldPath, file, path.DataPath)));
        }
        return new(plugin.Key, paths, unread);
    }

    private static PluginFilePaths Placement(RegisteredPlugin plugin, string failure) =>
        new(plugin.Key, [], [], failure, ProblemsFailureKind.Placement);
}
