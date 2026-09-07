using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Records;

/// <summary>Validate's tracked half (ADR-0046 invariant 6): a plugin's rows against the source
/// documents they came from, by content. A collaborator of <see cref="DuckDbRecordIndex"/>, which
/// owns every transaction, so the repairs go through its verbs.</summary>
internal sealed class SourceValidation(DuckDbRecordIndex index, DuckDBConnection connection, ILogger logger)
{
    /// <summary>One comparison per source document, so a clean plugin costs one read per file. An
    /// embedded child's system of record is its owner's document, so a matching document vouches for
    /// every row derived from it.</summary>
    internal ValidationReport Validate(PluginKey key, string modFolder)
    {
        var failures = new List<string>();
        var sourceRoot = Path.Combine(modFolder, SourceRecordPath.RootFor(key.Name));

        // Tracked but holding no tree for this plugin: nothing here can say what its rows should be,
        // and the caller's whole-plugin path already knows how to fall back to the binary.
        if (!Directory.Exists(sourceRoot))
            return new ValidationReport(key, [], NeedsRebuild: true, failures);

        var onDisk = DocumentsOnDisk(sourceRoot, key.Name, failures, out var treeFullyRead);
        var held = HeldDocuments(key);

        // A document the index never saw, or a held record with no document: either moves which
        // records the plugin has, which only a rebuild expresses. Concluded from a whole tree only.
        if (treeFullyRead && (onDisk.Keys.Except(held.Keys, StringComparer.Ordinal).Any()
                              || held.Keys.Except(onDisk.Keys, StringComparer.Ordinal).Any()))
        {
            return new ValidationReport(key, [], NeedsRebuild: true, failures);
        }

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

        return new ValidationReport(key, [.. goneAtHead, .. drifted], NeedsRebuild: false, failures);
    }

    // The committed half, from one ls-tree rather than a git process per record: a document whose
    // bytes are still a blob in that listing is clean at HEAD. Returns what the listing proves gone.
    private List<string> ValidateCommitted(
        PluginKey key, string modFolder, IEnumerable<string> documents, HashSet<string> drifted, List<string> failures)
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

            if (blobs.Contains(GitBlobHash.Of(Encoding.UTF8.GetBytes(headBody)))) continue;

            if (CommittedPathFor(listing.Keys, key.Name, formKey) != null) drifted.Add(formKey);
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

    // Asked in the one decidable direction (SourceUnitResolver.NameCarriesFormKey): a leaf may embed
    // an EditorID that itself contains the separator, so a name cannot be split, only tested.
    private static string? CommittedPathFor(IEnumerable<string> committedPaths, string pluginFileName, string formKey)
    {
        var headerPath = ToGitPath(Path.Combine(SourceRecordPath.RootFor(pluginFileName), SourceUnitResolver.RecordDataFileName));

        foreach (var path in committedPaths)
        {
            var leaf = path[(path.LastIndexOf('/') + 1)..];
            if (leaf.Equals(SourceUnitResolver.RecordDataFileName, StringComparison.Ordinal))
            {
                // The header's document has a fixed path and a name that carries no FormKey; every
                // other RecordData.json is named by the directory holding it.
                if (path.Equals(headerPath, StringComparison.Ordinal))
                {
                    if (formKey.Equals(HeaderIndexer.FormKeyFor(ModKey.FromFileName(pluginFileName)), StringComparison.Ordinal))
                        return path;
                    continue;
                }
                var container = path[..(path.LastIndexOf('/') + 1)].TrimEnd('/');
                leaf = container[(container.LastIndexOf('/') + 1)..];
            }

            if (SourceUnitResolver.NameCarriesFormKey(leaf, formKey)) return path;
        }
        return null;
    }

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    private string? HeadBody(PluginKey key, string formKey) =>
        DuckDbSql.ScalarString(connection,
            "SELECT body FROM records_head WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);

    // Keyed by the FormKey the document declares, never by its path: a file name carries an EditorID
    // that may contain the separator, so a path is not a decidable identity (SourceRecordPath).
    private static Dictionary<string, string> DocumentsOnDisk(
        string sourceRoot, string pluginFileName, List<string> failures, out bool fullyRead)
    {
        fullyRead = true;
        var headerPath = Path.Combine(sourceRoot, SourceUnitResolver.RecordDataFileName);
        var documents = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(sourceRoot, "*.json", SearchOption.AllDirectories))
        {
            // Group and block metadata, written only where a level has non-default metadata. It
            // carries no record and so claims no rows.
            if (Path.GetFileName(file).Equals(SourceUnitResolver.GroupRecordDataFileName, StringComparison.Ordinal))
                continue;

            string text;
            try
            {
                text = Encoding.UTF8.GetString(SourceUnitResolver.StripUtf8Bom(File.ReadAllBytes(file)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Never exclusive owners of a file: it may vanish or lock between the listing and the
                // read. A skip and a line, and the tree stops counting as evidence a record is gone.
                failures.Add($"Could not read '{file}': {ex.Message}");
                fullyRead = false;
                continue;
            }

            if (FormKeyDeclaredBy(text, file, headerPath, pluginFileName) is not { } formKey)
            {
                failures.Add($"'{file}' declares no FormKey, so the records it holds could not be validated.");
                fullyRead = false;
                continue;
            }

            documents[formKey] = text;
        }

        return documents;
    }

    // The header's document is the whole-mod door's root RecordData.json, which carries a ModKey
    // rather than a FormKey; HeaderIndexer computes the FormKey the index files it under.
    private static string? FormKeyDeclaredBy(string text, string file, string headerPath, string pluginFileName)
    {
        if (file.Equals(headerPath, StringComparison.Ordinal))
            return HeaderIndexer.FormKeyFor(ModKey.FromFileName(pluginFileName));

        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object
                   && document.RootElement.TryGetProperty("FormKey", out var formKey)
                   && formKey.ValueKind == JsonValueKind.String
                ? formKey.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // One row per source document: every Effective record no other record's document embeds. The
    // parent tables are SourceUnitResolver's own, asked in bulk instead of a scan per record.

    // A worldspace's TopCell is the one cell embedded rather than filed, and PlacementWalker leaves
    // its block coordinates null — what tells it from an exterior cell, which has a directory.
    private Dictionary<string, string> HeldDocuments(PluginKey key)
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
        DuckDbSql.AddParams(cmd, [key.Name, key.Origin!]);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            documents[reader.GetString(0)] = reader.GetString(1);
        return documents;
    }
}
