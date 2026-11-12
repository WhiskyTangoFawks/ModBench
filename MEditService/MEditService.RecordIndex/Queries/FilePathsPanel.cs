using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>The file paths each compiled plugin's source names, with the file that holds each naming record, one plugin's
/// records at a time. A record whose paths cannot be read is told as unread, never dropped.</summary>
internal static class FilePathsPanel
{
    public static IReadOnlyList<PluginFilePaths> Of(
        Indexer index, RelationReads reads, LoadOrderSnapshot snapshot, ISourceAdapter source,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, Func<RegisteredPlugin, UnreadableSource> whyUnreadable, PluginAddress? only)
    {
        var derivations = reads.GetDerivations();
        var stopped = index.SourceFileFailures.ToLookup(failure => failure.Plugin, PluginAddress.Comparer);
        return
        [
            .. snapshot.Plugins
                .Where(plugin => only is not { } one || PluginAddress.Comparer.Equals(plugin.Key, one))
                .Where(plugin => derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom.IsSourceMod())
                .Select(plugin =>
                {
                    if (index.LaterReadFailure(plugin.Key) is { } later)
                        return Failed(plugin, ReadFailures.LaterRead(later), ProblemsFailureKind.LaterRead);
                    if (derivations[plugin.Key] == DerivedFrom.BinaryForUnreadableSource)
                        return Failed(plugin, whyUnreadable(plugin).Reason, ProblemsFailureKind.Placement);
                    return source.Over(plugin, snapshot.GameRelease) is { } repository
                        ? PathsOf(plugin, reads.GetCopiesOf(plugin.Key), stopped[plugin.Key], repository, schemas)
                        : Failed(plugin, ReadFailures.NoModFolder(plugin.Name), ProblemsFailureKind.Placement);
                }),
        ];
    }

    private static PluginFilePaths PathsOf(
        RegisteredPlugin plugin, IEnumerable<CopyHoldingText> copies, IEnumerable<SourceFileFailure> stoppedAt,
        ISourceRepositoryReads repository, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var paths = new List<NamedFilePath>();
        var unread = new List<string>(stoppedAt.Select(file => $"{file.SourceRelativePath}: {file.Message}"));
        foreach (var copy in copies)
        {
            var (files, refused) = NamedBy(copy, plugin.Key, schemas);
            unread.AddRange(refused);
            if (files.Count == 0) continue;
            if (!SourceFilePlacement.Places(plugin.Key, new RecordIdentity(copy.FormKey, copy.RecordType, copy.EditorId), repository, out var file, out var failure))
                return Failed(plugin, failure, ProblemsFailureKind.Placement);
            paths.AddRange(files.Select(path => new NamedFilePath(copy.FormKey, path.FieldPath, file, path.DataPath.Replace('\\', '/'))));
        }
        return new(plugin.Key, paths, unread);
    }

    // A copy that cannot be read is told as unread and leaves the copies beside it answered.
    private static (IReadOnlyList<AssetPath> Files, IReadOnlyList<string> Unread) NamedBy(
        CopyHoldingText copy, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var named = ReadFailures.Copy(copy.FormKey, plugin);
        try
        {
            var found = AssetPaths.Collect(copy.Body, schemas[copy.RecordType].RecordColumns);
            return (found.Files, [.. found.Refusals.Select(refused => $"{named}: {refused.FieldPath}: {refused.Reason}")]);
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            return ([], [$"{named}: {ex.Message}"]);
        }
    }

    private static PluginFilePaths Failed(RegisteredPlugin plugin, string failure, ProblemsFailureKind kind) =>
        new(plugin.Key, [], [], failure, kind);
}
