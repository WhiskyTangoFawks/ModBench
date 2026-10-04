using DuckDB.NET.Data;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Validate's tracked half (ADR-0015): a plugin's rows against the source documents they
/// came from, by content stamp (ADR-0003). Repairs go through <see cref="DuckDbRecordIndex"/>'s verbs.</summary>
internal sealed class SourceValidation(
    DuckDbRecordIndex index, DuckDBConnection connection, GameRelease release, ILogger logger)
{
    internal ValidationReport Validate(PluginAddress key, string modFolder)
    {
        var failures = new List<string>();
        IReadOnlyDictionary<string, string> onDisk;
        bool treeFullyRead;
        try
        {
            var stamps = SourceRepository.Over(modFolder, release).StampsOf(key);
            onDisk = stamps.ByFormKey;
            failures.AddRange(stamps.Unreadable);
            // A file that could not be read is no evidence that a record is gone.
            treeFullyRead = stamps.Unreadable.Count == 0;
        }
        catch (AmbiguousSourceUnitException ex)
        {
            // The re-derivation is what diagnoses the tree on the plugin, as a first ingest would.
            failures.Add(ex.Message);
            return new ValidationReport([], NeedsRebuild: true, failures);
        }

        return Reconcile(key, modFolder, onDisk, HeldStamps(key), treeFullyRead, failures);
    }

    // An embedded child's system of record is its owner's document, so a matching document vouches
    // for every row derived from it.
    private ValidationReport Reconcile(
        PluginAddress key, string modFolder, IReadOnlyDictionary<string, string> onDisk,
        Dictionary<string, string> held, bool treeFullyRead, List<string> failures)
    {
        // A document the index never saw moves which records the plugin has, which only a rebuild
        // expresses; the report names the records gained. Concluded from a whole tree only.
        var gained = treeFullyRead ? onDisk.Keys.Except(held.Keys, StringComparer.Ordinal).ToList() : [];
        if (gained.Count > 0) return new ValidationReport(gained, NeedsRebuild: true, failures);

        // The tree files the records the rows hold, so from here the plugin loads from it (ADR-0007).
        if (treeFullyRead) index.RestampDerivation(key, DerivedFrom.SourceTree);

        var drifted = onDisk
            .Where(d => held.TryGetValue(d.Key, out var stamp) && !string.Equals(d.Value, stamp, StringComparison.Ordinal))
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
        var deleted = treeFullyRead ? held.Keys.Except(onDisk.Keys, StringComparer.Ordinal) : [];
        List<string> stale = [.. deleted, .. drifted];
        if (stale.Count > 0)
        {
            index.RefreshByKeys(key, modFolder, stale);
        }
        else if (index.LearnWorkingTreeStates(key, modFolder) is { Count: > 0 } moved)
        {
            index.PublishRowsChanged(key, moved);
        }

        return new ValidationReport([], NeedsRebuild: false, failures);
    }

    // One row per source document: every Effective record no document embeds. A worldspace's TopCell
    // is embedded, and its null block coordinates tell it from an exterior cell, which has a directory.
    private const string DocumentStamps = """
        SELECT r.form_key, r.content_hash
        FROM mirror.records r
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

    private Dictionary<string, string> HeldStamps(PluginAddress key)
    {
        var stamps = new Dictionary<string, string>(StringComparer.Ordinal);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = DocumentStamps;
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            stamps[reader.GetString(0)] = reader.GetString(1);
        return stamps;
    }
}
