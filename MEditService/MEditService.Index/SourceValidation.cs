using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Index;

/// <summary>Validate's tracked half (ADR-0015 invariant 4): a plugin's rows against the source
/// documents they came from, by content. A collaborator of <see cref="DuckDbRecordIndex"/>, which
/// owns every transaction, so the repairs go through its verbs.</summary>
internal sealed class SourceValidation(DuckDbRecordIndex index, DuckDBConnection connection, ILogger logger)
{
    /// <summary>One comparison per source document, so a clean plugin costs one read per file. An
    /// embedded child's system of record is its owner's document, so a matching document vouches for
    /// every row derived from it.</summary>
    internal ValidationReport Validate(PluginCopyKey key, string modFolder)
    {
        var failures = new List<string>();
        var sourceRoot = SourceRepository.RootIn(modFolder, key.Name);

        // Tracked but holding no tree for this plugin: nothing here can say what its rows should be,
        // and the caller's whole-plugin path already knows how to fall back to the binary.
        if (!Directory.Exists(sourceRoot))
            return new ValidationReport(key, [], NeedsRebuild: true, failures);

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
        var held = HeldDocuments(key);

        // A document the index never saw moves which records the plugin has, which only a rebuild
        // expresses; the report names the records gained. Concluded from a whole tree only.
        var gained = treeFullyRead ? onDisk.Keys.Except(held.Keys, StringComparer.Ordinal).ToList() : [];
        if (gained.Count > 0) return new ValidationReport(key, gained, NeedsRebuild: true, failures);

        // A held record with no document was deleted in the working tree: refreshed by key, so the
        // rows-changed it publishes names it (ADR-0015 invariant 3).
        var deleted = treeFullyRead ? held.Keys.Except(onDisk.Keys, StringComparer.Ordinal).ToList() : [];
        if (deleted.Count > 0)
        {
            index.RefreshByKeys(key, modFolder, deleted);
            foreach (var formKey in deleted) held.Remove(formKey);
        }

        // The tree files the records the rows hold, so from here the copy loads from it (ADR-0007
        // invariant 3): a copy tracked after it was indexed needs no more than the stamp.
        if (treeFullyRead) index.RestampDerivation(key, DerivedFrom.SourceTree);

        // A set, not a list: a document that disagrees at both refs is one drifted document and one
        // refresh, which re-derives it at both.
        var drifted = onDisk
            .Where(d => held.TryGetValue(d.Key, out var body) && !string.Equals(d.Value, body, StringComparison.Ordinal))
            .Select(d => d.Key)
            .ToHashSet(StringComparer.Ordinal);

        var goneAtHead = ValidateCommitted(key, modFolder, held.Keys, drifted, failures);

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
        PluginCopyKey key, string modFolder, IEnumerable<string> documents, HashSet<string> drifted, List<string> failures)
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

    private string? HeadBody(PluginCopyKey key, string formKey) =>
        DuckDbSql.ScalarString(connection,
            "SELECT body FROM records_head WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin);

    // One row per source document: every Effective record no other record's document embeds. The
    // parent tables are the repository's own, asked in bulk instead of a scan per record.

    // A worldspace's TopCell is the one cell embedded rather than filed, and PlacementWalker leaves
    // its block coordinates null — what tells it from an exterior cell, which has a directory.
    private Dictionary<string, string> HeldDocuments(PluginCopyKey key)
    {
        var documents = new Dictionary<string, string>(StringComparer.Ordinal);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
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
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            documents[reader.GetString(0)] = reader.GetString(1);
        return documents;
    }
}
