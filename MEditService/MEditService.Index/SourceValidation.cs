using System.Text;
using DuckDB.NET.Data;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Validate's tracked half (ADR-0015 invariant 4): a plugin's rows against the source
/// documents they came from, by content. A collaborator of <see cref="DuckDbRecordIndex"/>, which
/// owns every transaction, so the repairs go through its verbs.</summary>
internal sealed class SourceValidation(
    DuckDbRecordIndex index, DuckDBConnection connection, GameRelease release, ILogger logger)
{
    // One per index, so an open reads every document (ADR-0009).
    private readonly Dictionary<PluginAddress, string> _validatedHeads = new(PluginAddress.Comparer);

    /// <summary>The first validation reads every document, and each later one only what git names as
    /// changed since the HEAD it validated and what the index holds as dirty (ADR-0009).</summary>
    internal ValidationReport Validate(PluginAddress key, string modFolder)
    {
        // Tracked but holding no tree for this plugin: nothing here can say what its rows should be,
        // and the caller's whole-plugin path already knows how to fall back to the binary.
        if (!Directory.Exists(SourceRepository.RootIn(modFolder, key.Name)))
            return new ValidationReport(key, [], NeedsRebuild: true, []);

        var report = ValidateAgainstGit(key, modFolder, out var head);
        if (head is not null && report.Failures.Count == 0) _validatedHeads[key] = head;
        else _validatedHeads.Remove(key);
        return report;
    }

    private ValidationReport ValidateAgainstGit(PluginAddress key, string modFolder, out string? head)
    {
        _validatedHeads.TryGetValue(key, out var validatedHead);
        TreeChanges changes;
        try
        {
            changes = SourceRepository.Over(modFolder, release).ChangesSince(key, validatedHead);
        }
        catch (AmbiguousSourceUnitException ex)
        {
            head = null;
            return new ValidationReport(key, [], NeedsRebuild: true, [ex.Message]);
        }

        head = changes.Head;
        return changes.Documents is { } named && !NamesACopy(key, named)
            ? ValidateNamed(key, modFolder, named, headMoved: changes.Head != validatedHead)
            : ValidateWholeTree(key, modFolder);
    }

    private ValidationReport ValidateWholeTree(PluginAddress key, string modFolder)
    {
        var failures = new List<string>();
        IReadOnlyDictionary<string, string> onDisk;
        bool treeFullyRead;
        try
        {
            (onDisk, var unreadable) = SourceRepository.DocumentsByDeclaredFormKey(modFolder, key.Name);
            failures.AddRange(unreadable);
            // A file that could not be read is no evidence that a record is gone.
            treeFullyRead = unreadable.Count == 0;
        }
        catch (AmbiguousSourceUnitException ex)
        {
            // The re-derivation is what diagnoses the tree on the plugin, as a first ingest would.
            failures.Add(ex.Message);
            return new ValidationReport(key, [], NeedsRebuild: true, failures);
        }

        return Reconcile(key, modFolder, onDisk, HeldDocuments(key), treeFullyRead, validateCommitted: true, failures);
    }

    // Every document git names, and every one the index holds as dirty: git leaves that one unnamed
    // once it is clean again, so it reads as absent here and the refresh re-reads it.
    private ValidationReport ValidateNamed(
        PluginAddress key, string modFolder, IReadOnlyList<ChangedDocument> named, bool headMoved)
    {
        var onDisk = new Dictionary<string, string>(StringComparer.Ordinal);
        var held = HeldDivergedDocuments(key);
        foreach (var document in named)
        {
            if (document.WorkingTreeText is { } text) onDisk[document.FormKey] = text;
            foreach (var (formKey, body) in HeldDocument(key, document.FormKey)) held[formKey] = body;
        }

        var namedKeys = named.Select(d => d.FormKey).ToHashSet(StringComparer.Ordinal);
        foreach (var (formKey, headBody) in RestoredDocuments(key, modFolder, namedKeys))
            onDisk[formKey] = headBody;

        return Reconcile(key, modFolder, onDisk, held, treeFullyRead: true, validateCommitted: headMoved, []);
    }

    // A new path declaring a record HEAD holds, with no named path giving it up: a copy, whose
    // original only a whole-tree read sees.
    private bool NamesACopy(PluginAddress key, IReadOnlyList<ChangedDocument> named) =>
        named.Any(document =>
            document.NewPath && document.WorkingTreeText is not null
            && HeadBody(key, document.FormKey) is not null
            && !named.Any(other => other.FormKey == document.FormKey && other.WorkingTreeText is null));

    // A document deleted in the working tree that git leaves unnamed is back at HEAD's path. HEAD
    // alone holds such a record, so HEAD's listing tells a document from an embedded child.
    private IEnumerable<(string FormKey, string HeadBody)> RestoredDocuments(
        PluginAddress key, string modFolder, HashSet<string> namedKeys)
    {
        var deleted = DeletedInWorkingTree(key).Where(d => !namedKeys.Contains(d.Key)).ToList();
        if (deleted.Count == 0) return [];

        var listing = SourceRepository.CommittedSourceTree(modFolder, key.Name);
        if (listing is null) return [];
        return deleted
            .Where(d => SourceRepository.PathCarrying(listing.Keys, key.Name, d.Key) is not null)
            .Select(d => (d.Key, d.Value));
    }

    // An embedded child's system of record is its owner's document, so a matching document vouches
    // for every row derived from it.
    private ValidationReport Reconcile(
        PluginAddress key, string modFolder, IReadOnlyDictionary<string, string> onDisk,
        Dictionary<string, string> held, bool treeFullyRead, bool validateCommitted, List<string> failures)
    {
        // A document the index never saw moves which records the plugin has, which only a rebuild
        // expresses; the report names the records gained. Concluded from a whole tree only.
        var gained = treeFullyRead ? onDisk.Keys.Except(held.Keys, StringComparer.Ordinal).ToList() : [];
        if (gained.Count > 0) return new ValidationReport(key, gained, NeedsRebuild: true, failures);

        // A held record with no document here is refreshed by key, which reads it again, so the
        // rows-changed it publishes names it (ADR-0015 invariant 3).
        var deleted = treeFullyRead ? held.Keys.Except(onDisk.Keys, StringComparer.Ordinal).ToList() : [];
        if (deleted.Count > 0)
        {
            index.RefreshByKeys(key, modFolder, deleted);
            foreach (var formKey in deleted) held.Remove(formKey);
        }

        // The tree files the records the rows hold, so from here the plugin loads from it (ADR-0007
        // invariant 3): a plugin tracked after it was indexed needs no more than the stamp.
        if (treeFullyRead) index.RestampDerivation(key, DerivedFrom.SourceTree);

        // A set, not a list: a document that disagrees at both refs is one drifted document and one
        // refresh, which re-derives it at both.
        var drifted = onDisk
            .Where(d => held.TryGetValue(d.Key, out var body) && !string.Equals(d.Value, body, StringComparison.Ordinal))
            .Select(d => d.Key)
            .ToHashSet(StringComparer.Ordinal);

        // At an unmoved HEAD the committed rows stand as the last validation left them.
        var goneAtHead = validateCommitted ? ValidateCommitted(key, modFolder, held.Keys, drifted, failures) : [];

        // Before the refresh: a record whose document left HEAD keeps its working-tree rows, and the
        // refresh below would otherwise re-read a committed baseline this is about to retire.
        if (goneAtHead.Count > 0)
        {
            index.MarkWorkingTreeOnly(key, goneAtHead);
            index.PublishRowsChanged(key, goneAtHead);
        }

        if (drifted.Count > 0)
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "Validate found {Count} source document(s) of {Plugin} ({Origin}) disagreeing with the index; refreshing",
                    drifted.Count, key.Name, key.Origin);
            }
            index.RefreshByKeys(key, modFolder, [.. drifted]);
        }

        return new ValidationReport(key, [.. deleted, .. goneAtHead, .. drifted], NeedsRebuild: false, failures);
    }

    // The committed half, from one ls-tree rather than a git process per record: a document whose
    // bytes are still a blob in that listing is clean at HEAD. Returns what the listing proves gone.
    private List<string> ValidateCommitted(
        PluginAddress key, string modFolder, IEnumerable<string> documents, HashSet<string> drifted, List<string> failures)
    {
        var goneAtHead = new List<string>();

        var listing = SourceRepository.CommittedSourceTree(modFolder, key.Name);
        if (listing == null)
        {
            // git answers the same way for a genuinely empty tree and for a repository it cannot read,
            // so nothing here is evidence of anything: report it and leave the committed rows alone.
            failures.Add(
                $"Could not list the committed source tree of '{key.Name}' in '{modFolder}', so its " +
                "committed rows were not validated.");
            return goneAtHead;
        }

        var blobs = listing.Values.ToHashSet(StringComparer.Ordinal);
        // Only records the working tree still files a document for. A record held at HEAD alone says
        // nothing about whether it was a document or an embedded child, so it fails closed.
        foreach (var formKey in documents)
        {
            if (HeadBody(key, formKey) is not { } headBody) continue;

            if (blobs.Contains(SourceRepository.ContentHash(Encoding.UTF8.GetBytes(headBody)))) continue;

            if (SourceRepository.PathCarrying(listing.Keys, key.Name, formKey) != null) drifted.Add(formKey);
            else goneAtHead.Add(formKey);
        }

        if (goneAtHead.Count > 0 && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "{Count} record(s) of {Plugin} ({Origin}) are absent from the committed source tree; " +
                "dropping their committed rows", goneAtHead.Count, key.Name, key.Origin);
        }
        return goneAtHead;
    }

    private string? HeadBody(PluginAddress key, string formKey) =>
        DuckDbSql.ScalarString(connection,
            "SELECT body FROM records_head WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin);

    // One row per source document: every Effective record no other record's document embeds. The
    // parent tables are the repository's own, asked in bulk instead of a scan per record.

    // A worldspace's TopCell is the one cell embedded rather than filed, and PlacementWalker leaves
    // its block coordinates null — what tells it from an exterior cell, which has a directory.
    private const string DocumentRows = """
        SELECT r.form_key, r.body
        FROM records r
        WHERE r.plugin = $1 AND r.origin = $2
          AND NOT EXISTS (
            SELECT 1 FROM mirror.container_child c
            WHERE c.child_form_key = r.form_key AND c.plugin = r.plugin AND c.origin = r.origin)
          AND NOT EXISTS (
            SELECT 1 FROM mirror.placement p
            WHERE p.form_key = r.form_key AND p.plugin = r.plugin AND p.origin = r.origin)
          AND NOT EXISTS (
            SELECT 1 FROM mirror.cell_location l
            WHERE l.cell_form_key = r.form_key AND l.plugin = r.plugin AND l.origin = r.origin
              AND l.parent_worldspace IS NOT NULL AND l.block_x IS NULL)
        """;

    private Dictionary<string, string> HeldDocuments(PluginAddress key) => Rows(DocumentRows, key.Name, key.Origin);

    private Dictionary<string, string> HeldDivergedDocuments(PluginAddress key) =>
        Rows($"{DocumentRows} AND r.\"ref\" = '{SourceRef.WorkingTree}'", key.Name, key.Origin);

    private Dictionary<string, string> HeldDocument(PluginAddress key, string formKey) =>
        Rows($"{DocumentRows} AND r.form_key = $3", key.Name, key.Origin, formKey);

    // HEAD's bytes for each record the working tree holds no row of.
    private Dictionary<string, string> DeletedInWorkingTree(PluginAddress key) =>
        Rows("""
            SELECT c.form_key, c.body
            FROM records_committed c
            WHERE c.plugin = $1 AND c.origin = $2
              AND NOT EXISTS (
                SELECT 1 FROM records r
                WHERE r.form_key = c.form_key AND r.plugin = c.plugin AND r.origin = c.origin)
            """, key.Name, key.Origin);

    private Dictionary<string, string> Rows(string sql, params string[] parameters)
    {
        var rows = new Dictionary<string, string>(StringComparer.Ordinal);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        DuckDbSql.AddParams(cmd, parameters);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            rows[reader.GetString(0)] = reader.GetString(1);
        return rows;
    }
}
