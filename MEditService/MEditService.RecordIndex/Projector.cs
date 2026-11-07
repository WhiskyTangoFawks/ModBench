using System.Collections.Concurrent;
using System.Diagnostics;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.RecordIndex;

/// <summary>Reads a system of record (a compiled plugin's source tree, or its binary's hash) and writes
/// what differs into the Store (ADR-0015).</summary>
internal sealed class Projector(
    Store.Store index, Func<PluginAddress, PluginMetadata?> held, ISourceAdapter source, ILogger logger)
{
    /// <summary>The truth <paramref name="plugin"/> is derived from, as its folder answers now.</summary>
    internal DerivedFrom TruthOf(RegisteredPlugin plugin)
    {
        if (source.SourceReads(plugin)) return DerivedFrom.SourceTree;
        return source.IsSourceMod(plugin) ? DerivedFrom.BinaryForUnreadableSource : DerivedFrom.Binary;
    }

    private ISourceRepositoryReads Over(RegisteredPlugin plugin) =>
        source.Over(plugin, index.Release)
        ?? throw new InvalidOperationException($"'{plugin.Name}' from '{plugin.Origin}' reads a source tree, so a mod provides it.");

    /// <summary>Indexes the whole tree as the plugin, and answers what stopped the tree: "quietly served
    /// the binary instead" is a silent lie. The plugin's binary path only stamps the rows.</summary>
    internal SourceFailure? Ingest(PluginMetadata plugin, CancellationToken cancel = default)
    {
        cancel.ThrowIfCancellationRequested();
        _matched.TryRemove(plugin.Key, out _);

        // Over rather than Open: the documents read the same either way, and a repository verb over an
        // folder that is no source mod answers empty instead of throwing.
        var repository = Over(plugin.Registered);

        var timer = Stopwatch.StartNew();
        if (!repository.ReadDocuments(plugin.Key, documents =>
            {
                index.IndexTree(documents, plugin, plugin.Path, cancel);
                return true;
            }).Holds(out _, out var stopped))
        {
            return stopped;
        }
        var indexMs = timer.ElapsedMilliseconds;

        timer.Restart();
        if (!LearnWorkingTreeStates(plugin.Registered).Holds(out _, out stopped)) return stopped;
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Ingested {Plugin} from source: index {IndexMs} ms, working tree states {StatesMs} ms",
                plugin.Name, indexMs, timer.ElapsedMilliseconds);
        }
        return null;
    }

    /// <summary>Sets each of <paramref name="plugin"/>'s rows to how the Source repository says its
    /// record stands against the last commit (ADR-0007). Returns the keys that moved, for the caller
    /// to announce.</summary>
    internal Answer<IReadOnlyList<string>, SourceFailure> LearnWorkingTreeStates(RegisteredPlugin plugin)
    {
        var key = plugin.Key;
        if (!Over(plugin).ChangedSinceLastCommit(key).Holds(out var changes, out var stopped)) return stopped;

        var learned = changes.ToDictionary(
            change => change.Key,
            change => change.Value == RecordChange.Added ? WorkingTreeState.Added : WorkingTreeState.Modified,
            StringComparer.Ordinal);
        var differing = KeysDiffering(index.HeldWorkingTreeStates(key), learned).ToList();
        if (differing.Count == 0) return SourceAnswer.Of<IReadOnlyList<string>>([]);

        // A key git names with no row is a document saved since the stamps were read: a later check holds its row and names it.
        var stored = index.EffectiveContentHashes(key);
        var moved = differing
            .Where(stored.ContainsKey)
            .Select(formKey => (FormKey: formKey, State: learned.GetValueOrDefault(formKey)))
            .ToList();
        if (moved.Count == 0) return SourceAnswer.Of<IReadOnlyList<string>>([]);

        index.SetWorkingTreeStates(key, moved);
        return SourceAnswer.Of<IReadOnlyList<string>>([.. moved.Select(m => m.FormKey)]);
    }

    // A key absent from one side reads as that value's default: a clean row, or no row.
    private static IEnumerable<string> KeysDiffering<T>(
        IReadOnlyDictionary<string, T> before, IReadOnlyDictionary<string, T> after) =>
        before.Keys.Union(after.Keys, StringComparer.Ordinal)
            .Where(formKey => !EqualityComparer<T>.Default.Equals(
                before.GetValueOrDefault(formKey), after.GetValueOrDefault(formKey)));

    /// <summary>ADR-0015: re-derives <paramref name="formKeys"/>' rows from the Source repository,
    /// idempotent by content, the whole plugin for a key the record index does not hold. Answers what stopped
    /// the tree.</summary>
    internal SourceFailure? RefreshByKeys(RegisteredPlugin plugin, IReadOnlyList<string> formKeys) => index.Commit(projection =>
    {
        var key = plugin.Key;
        _matched.TryRemove(key, out _);

        // The tree is what these rows are re-derived from, so it is what the plugin is derived from
        // (ADR-0007), bytes moved or not: a plugin made compiled after indexing arrives here
        // still stamped from its binary.
        if (source.SourceReads(plugin))
            index.RestampDerivation(key, DerivedFrom.SourceTree);

        // A key the record index does not hold is a record the tree has gained or got back, and no document
        // says where the tree puts it: a new exterior cell's block is a directory, not a field.
        var stored = index.StoredRows(key, formKeys);
        if (formKeys.Any(formKey => !stored.ContainsKey(formKey)))
            return RederiveWholePluginFromSource(projection, plugin, formKeys);

        // One repository for the batch, so its listing memo and embedded-owner map are built once
        // rather than once per key.
        var repository = Over(plugin);
        var deltas = new List<(string FormKey, string? Body)>();
        foreach (var formKey in formKeys)
        {
            if (!ChangedDocument(repository, key, formKey, stored[formKey]).Holds(out var changed, out var stopped)) return stopped;
            if (changed is { } delta) deltas.Add(delta);
        }
        var touched = index.ProjectDocuments(key, deltas);
        if (!LearnWorkingTreeStates(plugin).Holds(out var moved, out var unlearned)) return unlearned;
        touched.AddRange(moved);

        // Embedded children are named, since a record panel open on a placed ref inside a refreshed
        // cell has no other signal.
        if (touched.Count > 0) AnnounceRows(projection, key, [.. touched.Distinct(StringComparer.Ordinal)]);
        return null;
    });

    // The document to project for one key, or none when the tree holds the bytes the rows came from.
    private Answer<(string FormKey, string? Body)?, SourceFailure> ChangedDocument(
        ISourceRepositoryReads repository, PluginAddress key, string formKey,
        (string RecordType, string? EditorId, string ContentHash) effective)
    {
        var identity = new RecordIdentity(formKey, effective.RecordType, effective.EditorId);
        if (!repository.RecordOf(key, identity).Holds(out var workingTree, out var stopped)) return stopped;
        var workingTreeText = workingTree?.Body;

        // Never exclusive owners of the file: it can be caught mid-save, or hand-edited into
        // something that is not a document. Rows stay as they stand until it reads as one again, and
        // the caller says why.
        if (workingTreeText != null && repository.WhyUnreadable(key, identity, workingTreeText) is { } unreadable) return unreadable;

        return workingTreeText != null
               && string.Equals(source.ContentStamp(workingTreeText), effective.ContentHash, StringComparison.Ordinal)
            ? SourceAnswer.Of<(string FormKey, string? Body)?>(null)
            : SourceAnswer.Of<(string FormKey, string? Body)?>((formKey, workingTreeText));
    }

    // The whole tree, read as one mod: where a record sits is a fact about the tree, not about one
    // document. Idempotent by construction, being the ingest init and a re-index run.
    private SourceFailure? RederiveWholePluginFromSource(
        Store.Store.Projection projection, RegisteredPlugin registered, IReadOnlyList<string> formKeys)
    {
        var key = registered.Key;
        // Nothing to re-derive from: the tree went away between the signal and this line, or the
        // rows came from its binary and a source key is not its to answer for.
        if (!source.SourceReads(registered)) return null;
        if (held(key) is not { } plugin)
        {
            logger.LogWarning(
                "Not re-deriving {Plugin} ({Origin}) from its source tree: it is not held", key.Name, key.Origin);
            return null;
        }

        var before = index.EffectiveContentHashes(key);
        var statesBefore = index.HeldWorkingTreeStates(key);
        if (Ingest(plugin) is { } stopped) return stopped;
        var after = index.EffectiveContentHashes(key);
        projection.OweWinnerSweep(before.Keys.Union(after.Keys));
        var statesAfter = index.HeldWorkingTreeStates(key);

        // ADR-0015: the keys asked about, and every row the tree read again moved, gone
        // or gained.
        var moved = KeysDiffering(before, after).Union(KeysDiffering(statesBefore, statesAfter), StringComparer.Ordinal);
        AnnounceRows(projection, key, [.. formKeys.Union(moved, StringComparer.Ordinal)]);
        return null;
    }

    private static void AnnounceRows(Store.Store.Projection projection, PluginAddress key, IReadOnlyList<string> formKeys) =>
        projection.Announce(sequence => new RowsChangedNotification(key, formKeys, sequence));

    /// <summary>ADR-0015: compares <paramref name="plugin"/>'s rows against the system of record they
    /// came from, the tree <paramref name="state"/> stamps or else the binary, and refreshes what
    /// differs.</summary>
    internal ValidationReport Validate(RegisteredPlugin plugin, ReadState state, Store.IndexedStamps indexed) =>
        state switch
        {
            // Rows from the tree stand over unsaved text that stops it; the read state says why.
            { Stamps.StoppedOnlyByUnsavedText: true } when indexed.DerivationOf(plugin.Key) == DerivedFrom.SourceTree =>
                ValidationReport.Clean,
            // The re-derivation is what diagnoses the tree on the plugin, as a first ingest would.
            { Stamps: { } stamps } when stamps.Claimed.Count > 0 || stamps.Unreadable.Count > 0 =>
                new ValidationReport(
                    [], NeedsRebuild: true,
                    [.. stamps.Unreadable.Select(file => file.Message), .. stamps.Claimed.Select(claim => claim.Message)]),
            { Stamps: { } stamps } => ValidateAgainstTree(plugin, stamps, indexed),
            _ => ValidateAgainstBinary(plugin, indexed),
        };

    // ADR-0003, asked of one plugin. A binary has no smaller unit, so a mismatch is a
    // rebuild the caller owns.
    private ValidationReport ValidateAgainstBinary(RegisteredPlugin plugin, Store.IndexedStamps indexed)
    {
        // Nothing vouches for these rows (an in-memory mod, or a compiled plugin whose folder went
        // away), so there is nothing to compare them against.
        if (indexed.FileOf(plugin.Key) is not { } claim) return ValidationReport.Clean;

        // Rows stamped from another truth came from a repository or tree that went away outside
        // Modbench (ADR-0007), or arrived, which the caller re-derives.
        if (indexed.DerivationOf(plugin.Key) != TruthOf(plugin))
            return new ValidationReport([], NeedsRebuild: true, []);

        // A file gone hashes as none, so the caller reads the plugin whole from where it is now.
        return index.FileContentHash(claim.FilePath) == claim.ContentHash
            ? ValidationReport.Clean
            : new ValidationReport([], NeedsRebuild: true, []);
    }

    // A commit moves what git status says and touches no document, so the repository stamp counts beside the documents'.
    private readonly ConcurrentDictionary<PluginAddress, (RecordStamps Documents, FilesStamp Repository)> _matched = new(PluginAddress.Comparer);

    /// <summary>Whether the plugin's tree last matched its rows, so a validation with its stamps unchanged reads no row.</summary>
    internal bool Matched(PluginAddress key) => _matched.ContainsKey(key);

    // A plugin's rows against the source documents they came from, by content stamp (ADR-0003).
    private ValidationReport ValidateAgainstTree(RegisteredPlugin plugin, RecordStamps stamps, Store.IndexedStamps indexed)
    {
        var repository = Over(plugin).RepositoryStamp();
        if (repository.Vouches && indexed.DerivationOf(plugin.Key) == DerivedFrom.SourceTree
            && _matched.TryGetValue(plugin.Key, out var last) && last.Documents.Equals(stamps) && last.Repository.Equals(repository))
        {
            index.ReclaimTreeBinary(plugin.Key, plugin.Path, indexed.FileOf(plugin.Key)?.ContentHash);
            return ValidationReport.Clean;
        }
        return Reconcile(plugin, stamps, repository, indexed.DocumentStampsOf(plugin.Key) ?? index.HeldDocumentStamps([plugin.Key])[plugin.Key]);
    }

    // An embedded child's system of record is its owner's document, so a matching document vouches
    // for every row derived from it.
    private ValidationReport Reconcile(
        RegisteredPlugin plugin, RecordStamps stamps, FilesStamp repository, Dictionary<string, string> heldStamps)
    {
        var onDisk = stamps.ByFormKey;
        var key = plugin.Key;
        // A document the record index never saw moves which records the plugin has, which only a rebuild
        // expresses; the report names the records gained.
        var gained = onDisk.Keys.Except(heldStamps.Keys, StringComparer.Ordinal).ToList();
        if (gained.Count > 0) return new ValidationReport(gained, NeedsRebuild: true, []);

        // The tree files the records the rows hold, so from here the plugin loads from it (ADR-0007).
        index.RestampDerivation(key, DerivedFrom.SourceTree);

        var drifted = onDisk
            .Where(d => heldStamps.TryGetValue(d.Key, out var stamp) && !string.Equals(d.Value, stamp, StringComparison.Ordinal))
            .Select(d => d.Key)
            .ToList();
        if (drifted.Count > 0 && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Validate found {Count} source document(s) of {Plugin} ({Origin}) disagreeing with the record index; refreshing",
                drifted.Count, key.Name, key.Origin);
        }

        // A held record with no document here is refreshed by key too, so the rows-changed it
        // publishes names it (ADR-0015). A refresh learns the working tree states itself.
        var deleted = heldStamps.Keys.Except(onDisk.Keys, StringComparer.Ordinal);
        List<string> stale = [.. deleted, .. drifted];
        var stopped = stale.Count > 0
            ? RefreshByKeys(plugin, stale)
            : index.Commit(projection =>
            {
                if (!LearnWorkingTreeStates(plugin).Holds(out var moved, out var unlearned)) return unlearned;
                if (moved.Count > 0) AnnounceRows(projection, key, moved);
                return null;
            });

        // A tree that stopped the refresh is read whole, which reads the binary in its place and says why.
        if (stopped is not null) return new ValidationReport([], NeedsRebuild: true, [stopped.Reason]);
        index.ReclaimTreeBinary(key, plugin.Path, index.IndexedFile(key)?.ContentHash);
        if (stale.Count == 0 && repository.Vouches) _matched[key] = (stamps, repository);
        return ValidationReport.Clean;
    }
}
