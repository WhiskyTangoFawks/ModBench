using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>The paths and scripts each compiled plugin's source names, with the file holding each naming record, one
/// plugin's records at a time. A record that cannot be read is told as unread, never dropped.</summary>
internal static class FilePathsPanel
{
    public static IReadOnlyList<PluginFilePaths> Of(
        Indexer index, RelationReads reads, LoadOrderSnapshot snapshot, ISourceAdapter source,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, Func<RegisteredPlugin, UnreadableSource> whyUnreadable, PluginAddress? only, RecordsAsked? asked = null)
    {
        var keys = RecordResults.KeysOf(asked);
        var derivations = reads.GetDerivations();
        var stopped = index.SourceFileFailures.ToLookup(failure => failure.Plugin, PluginAddress.Comparer);
        var held = ReadFailures.HeldReasons(index);
        return
        [
            .. snapshot.Plugins
                .Where(plugin => only is not { } one || PluginAddress.Comparer.Equals(plugin.Key, one))
                .Where(plugin => derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom.IsSourceMod())
                .Select(plugin =>
                {
                    if (index.LaterReadFailure(plugin.Key) is { } later)
                        return RecordResults.Of(Failed(plugin, ReadFailures.LaterRead(later), ProblemsFailureKind.LaterRead), NoUnread, asked);
                    if (derivations[plugin.Key] == DerivedFrom.BinaryForUnreadableSource)
                        return RecordResults.Of(Failed(plugin, whyUnreadable(plugin).Reason, ProblemsFailureKind.Placement), NoUnread, asked);
                    if (source.Over(plugin, snapshot.GameRelease) is not { } repository)
                        return RecordResults.Of(Failed(plugin, ReadFailures.NoModFolder(plugin.Name), ProblemsFailureKind.Placement), NoUnread, asked);
                    var copies = keys is null ? reads.GetCopiesOf(plugin.Key) : reads.GetCopies([.. keys.Select(key => new RecordAt(plugin.Key, key))]);
                    var (paths, unreadOf) = PathsOf(plugin, copies, stopped[plugin.Key], repository, schemas, held.GetValueOrDefault(plugin.Key));
                    return RecordResults.Of(paths, unreadOf, asked);
                }),
        ];
    }

    private static readonly IReadOnlyDictionary<string, List<string>> NoUnread = new Dictionary<string, List<string>>();

    private static (PluginFilePaths Paths, IReadOnlyDictionary<string, List<string>> UnreadOf) PathsOf(
        RegisteredPlugin plugin, IEnumerable<CopyHoldingText> copies, IEnumerable<SourceFileFailure> stoppedAt,
        ISourceRepositoryReads repository, IReadOnlyDictionary<string, RecordTableSchema> schemas, string? heldFailure)
    {
        var paths = new List<NamedFilePath>();
        var scripts = new List<NamedScript>();
        var unread = new List<string>(stoppedAt.Select(file => $"{file.SourceRelativePath}: {file.Message}"));
        var unreadOf = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var copy in copies)
        {
            var (files, attached, refused) = NamedBy(copy, plugin.Key, schemas);
            unread.AddRange(refused);
            if (refused.Count > 0) unreadOf[copy.FormKey] = [.. refused];
            if (files.Count == 0 && attached.Count == 0) continue;
            if (!SourceFilePlacement.Places(plugin.Key, new RecordIdentity(copy.FormKey, copy.RecordType, copy.EditorId), repository, out var file, out var failure))
                return (Failed(plugin, failure, ProblemsFailureKind.Placement), NoUnread);
            paths.AddRange(files.Select(path => new NamedFilePath(copy.FormKey, path.FieldPath, file, path.DataPath)));
            scripts.AddRange(attached.Select(script => new NamedScript(copy.FormKey, script.FieldPath, file, script.Name)));
        }
        // The rows stand, and the files that stopped the read stay named beside the reason (common.md, States, story 6).
        return (heldFailure is null
            ? new(plugin.Key, paths, scripts, unread)
            : new(plugin.Key, paths, scripts, unread, heldFailure, ProblemsFailureKind.LaterRead), unreadOf);
    }

    // A copy that cannot be read is told as unread and leaves the copies beside it answered.
    private static (IReadOnlyList<AssetPath> Files, IReadOnlyList<ScriptAttachment> Scripts, IReadOnlyList<string> Unread) NamedBy(
        CopyHoldingText copy, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var named = ReadFailures.Copy(copy.FormKey, plugin);
        try
        {
            var columns = schemas[copy.RecordType].RecordColumns;
            var found = AssetPaths.Collect(copy.Body, columns);
            return (found.Files, ScriptAttachments.Collect(copy.Body, columns), [.. found.Refusals.Select(refused => $"{named}: {refused.FieldPath}: {refused.Reason}")]);
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            return ([], [], [$"{named}: {ex.Message}"]);
        }
    }

    private static PluginFilePaths Failed(RegisteredPlugin plugin, string failure, ProblemsFailureKind kind) =>
        new(plugin.Key, [], [], [], failure, kind);
}
