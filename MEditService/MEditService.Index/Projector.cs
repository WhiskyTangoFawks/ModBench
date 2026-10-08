using System.Diagnostics;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Index;

/// <summary>Reads a system of record (a tracked plugin's source tree, or its binary's hash) and writes
/// what differs into the Store (ADR-0015).</summary>
internal sealed class Projector(
    DuckDbRecordIndex index, Func<PluginAddress, PluginMetadata?> held, ISourceAdapter source, ILogger logger)
{
    /// <summary>The truth <paramref name="plugin"/> is derived from, as its folder answers now.</summary>
    internal DerivedFrom TruthOf(RegisteredPlugin plugin)
    {
        if (source.SourceReads(plugin)) return DerivedFrom.SourceTree;
        return source.IsTracked(plugin) ? DerivedFrom.BinaryForUnreadableSource : DerivedFrom.Binary;
    }

    private ISourceRepositoryReads Over(RegisteredPlugin plugin) =>
        source.Over(plugin, index.Release)
        ?? throw new InvalidOperationException($"'{plugin.Name}' from '{plugin.Origin}' reads a source tree, so a mod provides it.");

    /// <summary>Indexes the whole tree as the plugin. Throws whatever the tree throws: "quietly served
    /// the binary instead" is a silent lie. The plugin's binary path only stamps the rows.</summary>
    internal void Ingest(PluginMetadata plugin, CancellationToken cancel = default)
    {
        cancel.ThrowIfCancellationRequested();

        // Over rather than Open: the documents read the same either way, and a repository verb over an
        // untracked folder answers empty instead of throwing.
        var repository = Over(plugin.Registered);

        var timer = Stopwatch.StartNew();
        using (var documents = repository.OpenDocuments(plugin.Key, index.Schemas))
            index.Index(documents, plugin, plugin.Path, DerivedFrom.SourceTree);
        var indexMs = timer.ElapsedMilliseconds;

        timer.Restart();
        LearnWorkingTreeStates(plugin.Registered);
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Ingested {Plugin} from source: index {IndexMs} ms, working tree states {StatesMs} ms",
                plugin.Name, indexMs, timer.ElapsedMilliseconds);
        }
    }

    /// <summary>Sets each of <paramref name="plugin"/>'s rows to how the Source repository says its
    /// record stands against the last commit (ADR-0007). Returns the keys that moved, for the caller
    /// to announce.</summary>
    internal IReadOnlyList<string> LearnWorkingTreeStates(RegisteredPlugin plugin)
    {
        var key = plugin.Key;
        var changes = Over(plugin).ChangedSinceLastCommit(key, index.Schemas);

        var learned = changes.ToDictionary(
            change => change.Key,
            change => change.Value == RecordChange.Added ? WorkingTreeState.Added : WorkingTreeState.Modified,
            StringComparer.Ordinal);
        var moved = KeysDiffering(index.HeldWorkingTreeStates(key), learned)
            .Select(formKey => (FormKey: formKey, State: learned.GetValueOrDefault(formKey)))
            .ToList();
        if (moved.Count == 0) return [];

        index.SetWorkingTreeStates(key, moved);
        return [.. moved.Select(m => m.FormKey)];
    }

    // A key absent from one side reads as that value's default: a clean row, or no row.
    private static IEnumerable<string> KeysDiffering<T>(
        IReadOnlyDictionary<string, T> before, IReadOnlyDictionary<string, T> after) =>
        before.Keys.Union(after.Keys, StringComparer.Ordinal)
            .Where(formKey => !EqualityComparer<T>.Default.Equals(
                before.GetValueOrDefault(formKey), after.GetValueOrDefault(formKey)));

    /// <summary>ADR-0015: re-derives <paramref name="formKeys"/>' rows from the Source repository,
    /// idempotent by content. A key the index does not hold re-derives the whole plugin.</summary>
    internal void RefreshByKeys(RegisteredPlugin plugin, IReadOnlyList<string> formKeys) => index.Commit(projection =>
    {
        var key = plugin.Key;

        // The tree is what these rows are re-derived from, so it is what the plugin is derived from
        // (ADR-0007), bytes moved or not: a plugin tracked after indexing arrives here
        // still stamped from its binary.
        if (source.SourceReads(plugin))
            index.RestampDerivation(key, DerivedFrom.SourceTree);

        // A key the index does not hold is a record the tree has gained or got back, and no document
        // says where the tree puts it: a new exterior cell's block is a directory, not a field.
        if (formKeys.Any(formKey => index.StoredRow(key, formKey) == null))
        {
            RederiveWholePluginFromSource(projection, plugin, formKeys);
            return;
        }

        // One repository for the batch, so its listing memo and embedded-owner map are built once
        // rather than once per key.
        var repository = Over(plugin);
        var touched = new List<string>();
        foreach (var formKey in formKeys)
            touched.AddRange(RefreshOneKey(repository, key, formKey));
        touched.AddRange(LearnWorkingTreeStates(plugin));

        // Embedded children are named, since a record panel open on a placed ref inside a refreshed
        // cell has no other signal.
        if (touched.Count > 0) AnnounceRows(projection, key, [.. touched.Distinct(StringComparer.Ordinal)]);
    });

    // Re-derives one key's rows. Called again with the same bytes, nothing below fires.
    private List<string> RefreshOneKey(ISourceRepositoryReads repository, PluginAddress key, string formKey)
    {
        // Gone since the batch was read: another key's projection in this same batch took it (a
        // container's document carries its children's rows).
        if (index.StoredRow(key, formKey) is not { } effective) return [];

        var identity = new RecordIdentity(formKey, effective.RecordType, effective.EditorId);
        var workingTreeText = repository.RecordOf(key, identity)?.Body;

        // Never exclusive owners of the file: it can be caught mid-save, or hand-edited into
        // something that is not a document. Rows stay as they stand until it reads as one again, and
        // the caller says why.
        if (workingTreeText != null && !IsDocument(workingTreeText))
        {
            throw new UnreadableSourceDocumentException(
                $"The source of {formKey} in {key.Name} ({key.Origin}) is not a readable document.");
        }
        if (workingTreeText != null) repository.RefuseUnreadable(key, identity, workingTreeText, index.Schemas);

        return string.Equals(workingTreeText, effective.Body, StringComparison.Ordinal)
            ? []
            : index.ProjectDocuments(key, [(formKey, workingTreeText)]);
    }

    private static bool IsDocument(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    // The whole tree, read as one mod: where a record sits is a fact about the tree, not about one
    // document. Idempotent by construction, being the ingest Track and a re-index run.
    private void RederiveWholePluginFromSource(
        DuckDbRecordIndex.Projection projection, RegisteredPlugin registered, IReadOnlyList<string> formKeys)
    {
        var key = registered.Key;
        // Nothing to re-derive from: the tree went away between the signal and this line, or the
        // rows came from its binary and a source key is not its to answer for.
        if (!source.SourceReads(registered)) return;
        if (held(key) is not { } plugin)
        {
            logger.LogWarning(
                "Not re-deriving {Plugin} ({Origin}) from its source tree: it is not held", key.Name, key.Origin);
            return;
        }

        var before = index.EffectiveContentHashes(key);
        var statesBefore = index.HeldWorkingTreeStates(key);
        Ingest(plugin);
        projection.OweWinnerSweep();
        var after = index.EffectiveContentHashes(key);
        var statesAfter = index.HeldWorkingTreeStates(key);

        // ADR-0015: the keys asked about, and every row the tree read again moved, gone
        // or gained.
        var moved = KeysDiffering(before, after).Union(KeysDiffering(statesBefore, statesAfter), StringComparer.Ordinal);
        AnnounceRows(projection, key, [.. formKeys.Union(moved, StringComparer.Ordinal)]);
    }

    private static void AnnounceRows(DuckDbRecordIndex.Projection projection, PluginAddress key, IReadOnlyList<string> formKeys) =>
        projection.Announce(sequence => new RowsChangedNotification(key, formKeys, sequence));

    /// <summary>ADR-0015: compares <paramref name="plugin"/>'s rows against the system of record they
    /// came from, the tree <paramref name="state"/> stamps or else the binary, and refreshes what
    /// differs.</summary>
    internal ValidationReport Validate(RegisteredPlugin plugin, ReadState state) =>
        state switch
        {
            // The re-derivation is what diagnoses the tree on the plugin, as a first ingest would.
            { Stamps: { } stamps } when stamps.Claimed.Count > 0 || stamps.Unreadable.Count > 0 =>
                new ValidationReport(
                    [], NeedsRebuild: true,
                    [.. stamps.Unreadable.Select(file => file.Message), .. stamps.Claimed.Select(claim => claim.Message)]),
            { Stamps: { } stamps } => ValidateAgainstTree(plugin, stamps),
            _ => ValidateAgainstBinary(plugin),
        };

    // ADR-0003, asked of one plugin. A binary has no smaller unit, so a mismatch is a
    // rebuild the caller owns.
    private ValidationReport ValidateAgainstBinary(RegisteredPlugin plugin)
    {
        // Nothing vouches for these rows (an in-memory mod, or a tracked plugin whose folder went
        // away), so there is nothing to compare them against.
        if (index.IndexedFile(plugin.Key) is not { } claim) return ValidationReport.Clean;

        // Rows stamped from another truth came from a repository or tree that went away outside
        // Modbench (ADR-0007), or arrived, which the caller re-derives.
        if (index.DerivationOf(plugin.Key) != TruthOf(plugin))
            return new ValidationReport([], NeedsRebuild: true, []);

        // A file gone hashes as none, so the caller reads the plugin whole from where it is now.
        return index.FileContentHash(claim.FilePath) == claim.ContentHash
            ? ValidationReport.Clean
            : new ValidationReport([], NeedsRebuild: true, []);
    }

    // A plugin's rows against the source documents they came from, by content stamp (ADR-0003).
    private ValidationReport ValidateAgainstTree(RegisteredPlugin plugin, RecordStamps stamps) =>
        Reconcile(plugin, stamps.ByFormKey, index.HeldDocumentStamps(plugin.Key));

    // An embedded child's system of record is its owner's document, so a matching document vouches
    // for every row derived from it.
    private ValidationReport Reconcile(
        RegisteredPlugin plugin, IReadOnlyDictionary<string, string> onDisk, Dictionary<string, string> heldStamps)
    {
        var key = plugin.Key;
        // A document the index never saw moves which records the plugin has, which only a rebuild
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
                "Validate found {Count} source document(s) of {Plugin} ({Origin}) disagreeing with the index; refreshing",
                drifted.Count, key.Name, key.Origin);
        }

        // A held record with no document here is refreshed by key too, so the rows-changed it
        // publishes names it (ADR-0015). A refresh learns the working tree states itself.
        var deleted = heldStamps.Keys.Except(onDisk.Keys, StringComparer.Ordinal);
        List<string> stale = [.. deleted, .. drifted];
        if (stale.Count > 0)
        {
            RefreshByKeys(plugin, stale);
        }
        else
        {
            index.Commit(projection =>
            {
                if (LearnWorkingTreeStates(plugin) is { Count: > 0 } moved) AnnounceRows(projection, key, moved);
            });
        }

        return ValidationReport.Clean;
    }
}
