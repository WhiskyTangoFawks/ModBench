using System.Diagnostics;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Records;

/// <summary>A tracked plugin's read model is seeded from its source, never the compiled artifact
/// (ADR-0003). The tree reads as documents, so tracked and untracked plugins share one
/// indexing call.</summary>
internal static class SourceIngest
{
    /// <summary>Whether this copy has a tree to ingest from; false reads the binary instead.
    /// Re-derived every call — MO2's Replace install shell-deletes the folder.</summary>
    internal static bool HoldsTree(string origin, string pluginPath, string pluginName) =>
        LoadOrder.ModFolderOf(origin, pluginPath) is { } modFolder
        && SourceRepository.HoldsTreeFor(modFolder, pluginName);

    /// <summary>Indexes the whole tree as the key. Throws whatever the tree throws: "quietly served the
    /// binary instead" is a silent lie. <paramref name="binaryPath"/> only stamps the rows; null
    /// claims no file backs them.</summary>
    internal static void Ingest(
        IRecordIndex index, string modFolder, Registration registration,
        PluginKey key, string? binaryPath, GameRelease gameRelease, SchemaReflector schemaReflector,
        ILogger logger, CancellationToken cancel = default)
    {
        cancel.ThrowIfCancellationRequested();
        var schemas = schemaReflector.GetSchemas(gameRelease);

        // Over rather than Open: the documents read the same either way, and a repository verb over an
        // untracked folder answers empty instead of throwing.
        var repository = SourceRepository.Over(modFolder, gameRelease);

        var timer = Stopwatch.StartNew();
        using (var documents = repository.OpenDocuments(key, schemas))
            index.Index(documents, registration, key, binaryPath);
        var indexMs = timer.ElapsedMilliseconds;

        timer.Restart();
        ReconcileHead(index, repository, key, schemas, logger);
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Ingested {Plugin} from source: index {IndexMs} ms, reconcile {ReconcileMs} ms",
                key.Name, indexMs, timer.ElapsedMilliseconds);
        }
    }

    // Moves the dirty records back onto HEAD, as the tree's own dirt reports each of them: a record
    // still there with committed text behind it, one the tree has gained, one it has lost.
    private static void ReconcileHead(
        IRecordIndex index, SourceRepository repository, PluginKey key,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, ILogger logger)
    {
        var dirt = repository.DirtOf(key);

        // The clean fast path: reconciling every record would still be correct, so no test can tell
        // bounded from unbounded here; keep the bound anyway.
        if (dirt.Documents.Count == 0 && !dirt.NeedsStructuralPass) return;

        var baselines = new List<(string FormKey, string Body)>();
        var workingTreeOnly = new List<string>();
        var deletedInWorkingTree = new List<(string FormKey, string RecordType, string Body)>();

        foreach (var document in dirt.Documents)
        {
            // A deletion or a create moves which refs hold the record at all, which SetCommittedBaseline
            // cannot express; each gets its own verb.
            if (document.CommittedText is not { } committed)
                workingTreeOnly.Add(document.FormKey);
            else if (document.InWorkingTree)
                baselines.Add((document.FormKey, committed));
            else
                deletedInWorkingTree.Add((document.FormKey, document.RecordType, committed));
        }

        PairRenamedSourceUnits(baselines, workingTreeOnly, deletedInWorkingTree);

        if (dirt.NeedsStructuralPass)
        {
            ReconcileHeadStructurally(
                repository, key, schemas, logger, baselines, workingTreeOnly, deletedInWorkingTree);
        }

        // Applied only once the whole dirty set has been read: a throw mid-loop leaves Head untouched
        // rather than half-moved, and the caller's re-ingest from the binary would otherwise see two rows
        // per FormKey.
        index.SetCommittedBaseline(key, baselines);
        index.MarkWorkingTreeOnly(key, workingTreeOnly);
        index.SeedCommittedOnly(key, deletedInWorkingTree);
    }

    // Diffs HEAD's documents against the working tree's by FormKey, needing no path identity
    // (ADR-0003). A schema-unpublished type is skipped on the deletion side only: a
    // Head-only row for it could never be read back.
    private static void ReconcileHeadStructurally(
        SourceRepository repository, PluginKey key,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, ILogger logger,
        List<(string FormKey, string Body)> baselines,
        List<string> workingTreeOnly,
        List<(string FormKey, string RecordType, string Body)> deletedInWorkingTree)
    {
        var alreadyHandled = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (formKey, _) in baselines) alreadyHandled.Add(formKey);
        foreach (var formKey in workingTreeOnly) alreadyHandled.Add(formKey);
        foreach (var (formKey, _, _) in deletedInWorkingTree) alreadyHandled.Add(formKey);

        using var tree = repository.OpenDocuments(key, schemas);
        var effective = DocumentsByFormKey(tree.Records);
        var head = DocumentsByFormKey(CommittedDocuments(repository, key, schemas));

        foreach (var (formKey, headDocument) in head)
        {
            if (alreadyHandled.Contains(formKey)) continue;

            if (!effective.TryGetValue(formKey, out var effectiveDocument))
            {
                if (!schemas.ContainsKey(headDocument.RecordType))
                {
                    if (logger.IsEnabled(LogLevel.Debug))
                    {
                        logger.LogDebug(
                            "{FormKey} ({RecordType}) is not a schema-published record type, so its " +
                            "working-tree deletion is not seeded at Head", formKey, headDocument.RecordType);
                    }
                    continue;
                }

                deletedInWorkingTree.Add((formKey, headDocument.RecordType, headDocument.Text));
                continue;
            }

            if (!string.Equals(effectiveDocument.Text, headDocument.Text, StringComparison.Ordinal))
                baselines.Add((formKey, headDocument.Text));
        }

        foreach (var formKey in effective.Keys)
        {
            if (head.ContainsKey(formKey) || alreadyHandled.Contains(formKey)) continue;
            workingTreeOnly.Add(formKey);
        }
    }

    // Last one wins, as the reader's FormKey-keyed cache does for a tree that files one FormKey twice.
    private static Dictionary<string, PluginDocument> DocumentsByFormKey(IEnumerable<PluginDocument> documents)
    {
        var byFormKey = new Dictionary<string, PluginDocument>(StringComparer.Ordinal);
        foreach (var document in documents) byFormKey[document.FormKey] = document;
        return byFormKey;
    }

    // The header is left out because the flat pass above already reconciles it by name: no text in the
    // tree carries the FormKey the index files it under.
    private static IEnumerable<PluginDocument> CommittedDocuments(
        SourceRepository repository, PluginKey key, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(key.Name));
        return repository.DocumentsAt(key, "HEAD", schemas)
            .Where(document => !document.FormKey.Equals(headerFormKey, StringComparison.OrdinalIgnoreCase));
    }

    // An EditorID edit moves the file, so one FormKey shows as a delete plus a create, which would land
    // in both halves of records_head. Only flat records reach here; renamed containers go through the
    // structural pass.
    private static void PairRenamedSourceUnits(
        List<(string FormKey, string Body)> baselines,
        List<string> workingTreeOnly,
        List<(string FormKey, string RecordType, string Body)> deletedInWorkingTree)
    {
        if (workingTreeOnly.Count == 0 || deletedInWorkingTree.Count == 0) return;

        var created = workingTreeOnly.ToHashSet(StringComparer.Ordinal);
        var renamed = deletedInWorkingTree.Where(d => created.Contains(d.FormKey)).ToList();
        if (renamed.Count == 0) return;

        foreach (var (formKey, _, headBody) in renamed)
        {
            baselines.Add((formKey, headBody));
            workingTreeOnly.Remove(formKey);
        }

        deletedInWorkingTree.RemoveAll(d => created.Contains(d.FormKey));
    }
}
