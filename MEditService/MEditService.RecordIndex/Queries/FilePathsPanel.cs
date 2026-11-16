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
        Func<RegisteredPlugin, UnreadableSource> whyUnreadable, PluginAddress? only, RecordsAsked? asked = null)
    {
        var derivations = reads.GetDerivations();
        var stopped = index.SourceFileFailures.ToLookup(failure => failure.Plugin, PluginAddress.Comparer);
        var held = ReadFailures.HeldReasons(index);
        var named = reads.GetDocumentNames(only, RecordResults.KeysOf(asked)).ToLookup(found => found.Plugin, found => found.Row, PluginAddress.Comparer);
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
                    var (paths, unreadOf) = PathsOf(plugin, named[plugin.Key], stopped[plugin.Key], repository, held.GetValueOrDefault(plugin.Key));
                    return RecordResults.Of(paths, unreadOf, asked);
                }),
        ];
    }

    private static readonly IReadOnlyDictionary<string, List<string>> NoUnread = new Dictionary<string, List<string>>();

    private static (PluginFilePaths Paths, IReadOnlyDictionary<string, List<string>> UnreadOf) PathsOf(
        RegisteredPlugin plugin, IEnumerable<DocumentNameRow> rows, IEnumerable<SourceFileFailure> stoppedAt,
        ISourceRepositoryReads repository, string? heldFailure)
    {
        var paths = new List<NamedFilePath>();
        var scripts = new List<NamedScript>();
        var unread = new List<string>(stoppedAt.Select(file => $"{file.SourceRelativePath}: {file.Message}"));
        var unreadOf = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var copy in rows.GroupBy(row => row.FormKey, StringComparer.OrdinalIgnoreCase))
        {
            var named = ReadFailures.Copy(copy.Key, plugin.Key);
            var refused = copy.Where(row => row.Refusal is not null).Select(row => $"{named}: {row.FieldPath}: {row.Refusal}").ToList();
            unread.AddRange(refused);
            if (refused.Count > 0) unreadOf[copy.Key] = refused;
            var first = copy.First();
            if (copy.All(row => row.Refusal is not null)) continue;
            if (!SourceFilePlacement.Places(plugin.Key, new RecordIdentity(first.FormKey, first.RecordType, first.EditorId), repository, out var file, out var failure))
                return (Failed(plugin, failure, ProblemsFailureKind.Placement), NoUnread);
            foreach (var row in copy)
            {
                if (row.Refusal is not null || row.Name is not { } name) continue;
                if (row.Kind == DocumentNameKind.File) paths.Add(new NamedFilePath(row.FormKey, row.FieldPath, file, name));
                else scripts.Add(new NamedScript(row.FormKey, row.FieldPath, file, name));
            }
        }
        // The rows stand, and the files that stopped the read stay named beside the reason (common.md, States, story 6).
        return (heldFailure is null
            ? new(plugin.Key, paths, scripts, unread)
            : new(plugin.Key, paths, scripts, unread, heldFailure, ProblemsFailureKind.LaterRead), unreadOf);
    }

    private static PluginFilePaths Failed(RegisteredPlugin plugin, string failure, ProblemsFailureKind kind) =>
        new(plugin.Key, [], [], [], failure, kind);
}
