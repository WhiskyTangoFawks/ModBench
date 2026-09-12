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
    /// <summary>The tree to ingest from, or null to use the binary: no mod folder, untracked, or tracked
    /// but holding no tree for this plugin. Re-derived every call, never cached — MO2's Replace install
    /// shell-deletes the folder.</summary>
    internal static string? TreeFor(string origin, string pluginPath, string pluginName)
    {
        if (ModFolders.Of(origin, pluginPath) is not { } modFolder) return null;
        if (!SourceRepository.IsTracked(modFolder)) return null;

        var tree = Path.Combine(modFolder, SourceRepository.RootFor(pluginName));
        return Directory.Exists(tree) ? tree : null;
    }

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

        var timer = Stopwatch.StartNew();
        using (var documents = new SourceTreeDocuments(modFolder, key.Name, gameRelease, schemas))
            index.Index(documents, registration, key, binaryPath);
        var indexMs = timer.ElapsedMilliseconds;

        timer.Restart();
        ReconcileHead(index, modFolder, key, gameRelease, schemas, logger);
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Ingested {Plugin} from source: index {IndexMs} ms, reconcile {ReconcileMs} ms",
                key.Name, indexMs, timer.ElapsedMilliseconds);
        }
    }

    // Moves the dirty records back onto HEAD. The dirty set comes from git status, not a content_hash
    // compare: the hash is of the codec's canonical form, so any other tree would read as wholly dirty.
    private static void ReconcileHead(
        IRecordIndex index, string modFolder, PluginKey key, GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, ILogger logger)
    {
        // The clean fast path: reconciling every record would still be correct, so no test can tell bounded
        // from unbounded here; keep the bound anyway.
        var dirty = SourceRepository.WorkingTreeStatus(modFolder);
        if (dirty.Count == 0) return;

        var baselines = new List<(string FormKey, string Body)>();
        var workingTreeOnly = new List<string>();
        var deletedInWorkingTree = new List<(string FormKey, string RecordType, string Body)>();
        var needsStructuralFallback = false;

        // Which plugin's subtree a dirty path sits under — not a container-path grammar (ADR-0003).
        var ownTreePrefix = $"{SourceRepository.RootFor(key.Name)}{Path.DirectorySeparatorChar}";

        foreach (var gitPath in dirty)
        {
            // git speaks forward slashes on every platform; the layout splits on the platform's
            // own separator, so a raw porcelain path would simply never parse on Windows.
            var relativePath = gitPath.Replace('/', Path.DirectorySeparatorChar);

            if (!SourceRepository.TryParseDocumentPath(relativePath, gameRelease, out var identity))
            {
                // Not a flat record file: a path under this plugin's own tree (a container) defers to the
                // structural pass, once, after the loop; a path outside it carries nothing to reconcile.
                if (relativePath.StartsWith(ownTreePrefix, StringComparison.OrdinalIgnoreCase))
                {
                    needsStructuralFallback = true;
                }
                else
                {
                    if (logger.IsEnabled(LogLevel.Debug))
                    {
                        logger.LogDebug(
                            "Not a flat source record and not under {Plugin}'s own tree, so it carries no " +
                            "Head state to reconcile here: {Path}", key.Name, gitPath);
                    }
                }
                continue;
            }

            if (!identity.PluginFileName.Equals(key.Name, StringComparison.OrdinalIgnoreCase)) continue;

            // A deletion or a create moves which refs hold the record at all, which SetCommittedBaseline cannot
            // express; each gets its own verb.
            var fullPath = Path.Combine(modFolder, relativePath);
            var headText = SourceRepository.ReadCommittedSourceText(modFolder, relativePath);

            // The header: its FormKey is computed directly, since a ModHeader cannot flow through the
            // per-record codec, and the structural pass cannot reach it either.
            if (identity.RecordType == PluginHeader.RecordType)
            {
                var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(identity.PluginFileName));

                if (!File.Exists(fullPath))
                {
                    if (headText != null)
                        deletedInWorkingTree.Add((headerFormKey, PluginHeader.RecordType, headText));
                    continue;
                }

                if (headText == null)
                    workingTreeOnly.Add(headerFormKey);
                else
                    baselines.Add((headerFormKey, headText));
                continue;
            }

            if (!File.Exists(fullPath))
            {
                // Deleted in the working tree: gone at Effective, but it must keep answering at Head so the user
                // can see, diff or revert it (ADR-0007).
                if (headText != null)
                {
                    var goneFormKey = SourceRepository.RootStringIn(headText, FormKeyMember)
                        ?? throw new UnreadableSourceDocumentException(
                            fullPath, "the text HEAD committed for it declares no FormKey");
                    deletedInWorkingTree.Add((goneFormKey, identity.RecordType, headText));
                }
                continue;
            }

            // Identity from the document, not the path: an EditorID may contain " - " (SourceRecordIdentity).
            // Null covers an unreadable file as well as one declaring nothing, and a file that races
            // this read is exactly what must degrade visibly rather than go missing.
            var formKey = SourceRepository.FormKeyDeclaredBy(fullPath, modFolder, key.Name)
                ?? throw new UnreadableSourceDocumentException(fullPath, "it declares no FormKey");

            if (headText == null)
            {
                // Created and not yet committed — the ordinary shape, since the write path never runs git add.
                workingTreeOnly.Add(formKey);
                continue;
            }

            baselines.Add((formKey, headText));
        }

        PairRenamedSourceUnits(baselines, workingTreeOnly, deletedInWorkingTree);

        if (needsStructuralFallback)
        {
            ReconcileHeadStructurally(
                modFolder, key, gameRelease, schemas, logger,
                baselines, workingTreeOnly, deletedInWorkingTree);
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
        string modFolder, PluginKey key, GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, ILogger logger,
        List<(string FormKey, string Body)> baselines,
        List<string> workingTreeOnly,
        List<(string FormKey, string RecordType, string Body)> deletedInWorkingTree)
    {
        var alreadyHandled = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (formKey, _) in baselines) alreadyHandled.Add(formKey);
        foreach (var formKey in workingTreeOnly) alreadyHandled.Add(formKey);
        foreach (var (formKey, _, _) in deletedInWorkingTree) alreadyHandled.Add(formKey);

        using var tree = new SourceTreeDocuments(modFolder, key.Name, gameRelease, schemas);
        var effective = DocumentsByFormKey(tree.Records);
        var head = DocumentsByFormKey(CommittedDocuments(tree, modFolder, key, gameRelease));

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

    // HEAD's own documents, straight from the object store: no checkout and no second working tree.
    // The header is excluded because the flat pass above already reconciles it by name.
    private static IEnumerable<PluginDocument> CommittedDocuments(
        SourceTreeDocuments tree, string modFolder, PluginKey key, GameRelease gameRelease)
    {
        if (SourceRepository.Open(modFolder, gameRelease) is not { } repository) yield break;

        foreach (var document in repository.ReadAll(key, "HEAD"))
        {
            if (document.RecordType.Equals(PluginHeader.RecordType, StringComparison.Ordinal)) continue;
            foreach (var expanded in tree.Expand(document.RecordType, document.FormKey, document.Body))
                yield return expanded;
        }
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

    private const string FormKeyMember = "FormKey";
}
