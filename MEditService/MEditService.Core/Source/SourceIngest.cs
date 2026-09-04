using System.Diagnostics;
using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Source;

/// <summary>A tracked plugin's read model is seeded from its source, never the compiled artifact
/// (ADR-0041 amendment). The tree deserializes to an IModGetter, so tracked and untracked plugins
/// share one indexing call. A designated whole-mod door.</summary>
internal static class SourceIngest
{
    /// <summary>The tree to ingest from, or null to use the binary: no mod folder, untracked, or tracked
    /// but holding no tree for this plugin. Re-derived every call, never cached — MO2's Replace install
    /// shell-deletes the folder.</summary>
    internal static string? TreeFor(string origin, string pluginPath, string pluginName)
    {
        if (ModFolders.Of(origin, pluginPath) is not { } modFolder) return null;
        if (!SourceRepository.IsTracked(modFolder)) return null;

        var tree = Path.Combine(modFolder, SourceRecordPath.RootFor(pluginName));
        return Directory.Exists(tree) ? tree : null;
    }

    /// <summary>Indexes the whole tree as the key. Throws whatever the tree throws: "quietly served the
    /// binary instead" is the silent lie the caller's visible failure prevents.
    /// <paramref name="binaryPath"/> only stamps the rows.</summary>
    internal static void Ingest(
        IRecordIndex index, string modFolder, string sourceTree, Registration registration,
        PluginKey key, string binaryPath, GameRelease gameRelease, SchemaReflector schemaReflector,
        ILogger logger, CancellationToken cancel = default)
    {
        var timer = Stopwatch.StartNew();
        // Blocking is deliberate: the reconcile loop is synchronous, and making IRecordIndex async to
        // match Mutagen's signature would push a false shape upward.
        var mod = RecordTextCodecGeneratorSeed
            .DeserializeWholeMod(sourceTree, InlineWorkDropoff.Instance, cancel)
            .GetAwaiter().GetResult();
        var deserializeMs = timer.ElapsedMilliseconds;

        timer.Restart();
        index.Index(mod, registration, key, binaryPath);
        var indexMs = timer.ElapsedMilliseconds;

        timer.Restart();
        ReconcileHead(index, modFolder, key, gameRelease, schemaReflector, logger, mod);
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Ingested {Plugin} from source: deserialize {DeserializeMs} ms, index {IndexMs} ms, reconcile {ReconcileMs} ms",
                key.Name, deserializeMs, indexMs, timer.ElapsedMilliseconds);
        }
    }

    // Moves the dirty records back onto HEAD. The dirty set comes from git status, not a content_hash
    // compare: the hash is of the codec's canonical form, so any other tree would read as wholly dirty.
    private static void ReconcileHead(
        IRecordIndex index, string modFolder, PluginKey key, GameRelease gameRelease,
        SchemaReflector schemaReflector, ILogger logger, IModGetter effectiveMod)
    {
        // The clean fast path: reconciling every record would still be correct, so no test can tell bounded
        // from unbounded here; keep the bound anyway.
        var dirty = SourceRepository.WorkingTreeStatus(modFolder);
        if (dirty.Count == 0) return;

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var baselines = new List<(string FormKey, string Body)>();
        var workingTreeOnly = new List<string>();
        var deletedInWorkingTree = new List<(string FormKey, string RecordType, string Body)>();
        var needsStructuralFallback = false;

        // Which plugin's subtree a dirty path sits under — not a container-path grammar (ADR-0041 amendment).
        var ownTreePrefix = $"{SourceRecordPath.RootFor(key.Name)}{Path.DirectorySeparatorChar}";

        foreach (var gitPath in dirty)
        {
            // git speaks forward slashes on every platform; SourceRecordPath splits on the platform's
            // own separator, so a raw porcelain path would simply never parse on Windows.
            var relativePath = gitPath.Replace('/', Path.DirectorySeparatorChar);

            if (!SourceRecordPath.TryParse(relativePath, gameRelease, out var identity))
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

            // The header (#661): its FormKey is computed directly, since a ModHeader cannot flow through the
            // per-record codec, and the structural pass cannot reach it either.
            if (identity.RecordType == HeaderIndexer.RecordType)
            {
                var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(identity.PluginFileName));

                if (!File.Exists(fullPath))
                {
                    if (headText != null)
                        deletedInWorkingTree.Add((headerFormKey, HeaderIndexer.RecordType, headText));
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
                // can see, diff or revert it (ADR-0041).
                if (headText != null)
                    deletedInWorkingTree.Add(DeletedInWorkingTree(codec, gameRelease, identity, headText));
                continue;
            }

            // Identity from the document, not the path: an EditorID may contain " - " (SourceRecordIdentity).
            var record = codec.DeserializeAsync(fullPath, gameRelease, identity.RecordType).GetAwaiter().GetResult();

            if (headText == null)
            {
                // Created and not yet committed — the ordinary shape, since the write path never runs git add.
                workingTreeOnly.Add(record.FormKey.ToString());
                continue;
            }

            baselines.Add((record.FormKey.ToString(), headText));
        }

        PairRenamedSourceUnits(baselines, workingTreeOnly, deletedInWorkingTree);

        if (needsStructuralFallback)
        {
            ReconcileHeadStructurally(
                modFolder, key, gameRelease, schemaReflector, codec, effectiveMod, logger,
                baselines, workingTreeOnly, deletedInWorkingTree);
        }

        // Applied only once the whole dirty set has been read: a throw mid-loop leaves Head untouched
        // rather than half-moved, and the caller's re-ingest from the binary would otherwise see two rows
        // per FormKey.
        index.SetCommittedBaseline(key, baselines);
        index.MarkWorkingTreeOnly(key, workingTreeOnly);
        index.SeedCommittedOnly(key, deletedInWorkingTree);
    }

    // Diffs HEAD's tree against the effective mod by FormKey, needing no path identity (ADR-0041
    // amendment). A schema-unpublished type is skipped on the deletion side only: a Head-only row for
    // it could never be read back.
    private static void ReconcileHeadStructurally(
        string modFolder, PluginKey key, GameRelease gameRelease, SchemaReflector schemaReflector,
        RecordTextCodec codec, IModGetter effectiveMod, ILogger logger,
        List<(string FormKey, string Body)> baselines,
        List<string> workingTreeOnly,
        List<(string FormKey, string RecordType, string Body)> deletedInWorkingTree)
    {
        var headMod = DeserializeHeadTree(modFolder, key.Name);
        var schemas = schemaReflector.GetSchemas(gameRelease);

        var alreadyHandled = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (formKey, _) in baselines) alreadyHandled.Add(formKey);
        foreach (var formKey in workingTreeOnly) alreadyHandled.Add(formKey);
        foreach (var (formKey, _, _) in deletedInWorkingTree) alreadyHandled.Add(formKey);

        var effectiveByFormKey = effectiveMod.EnumerateMajorRecords()
            .ToDictionary(r => r.FormKey.ToString(), StringComparer.Ordinal);
        var headFormKeys = new HashSet<string>(StringComparer.Ordinal);

        foreach (var headRecord in headMod.EnumerateMajorRecords())
        {
            var formKey = headRecord.FormKey.ToString();
            headFormKeys.Add(formKey);
            if (alreadyHandled.Contains(formKey)) continue;

            var headBody = Encoding.UTF8.GetString(
                codec.SerializeToBytesAsync(headRecord, gameRelease).GetAwaiter().GetResult());

            if (!effectiveByFormKey.TryGetValue(formKey, out var effectiveRecord))
            {
                var recordType = SourceRecordType.Resolve(headRecord, schemas);
                if (!schemas.ContainsKey(recordType))
                {
                    if (logger.IsEnabled(LogLevel.Debug))
                    {
                        logger.LogDebug(
                            "{FormKey} ({RecordType}) is not a schema-published record type, so its " +
                            "working-tree deletion is not seeded at Head", formKey, recordType);
                    }
                    continue;
                }

                deletedInWorkingTree.Add((formKey, recordType, headBody));
                continue;
            }

            var effectiveBody = Encoding.UTF8.GetString(
                codec.SerializeToBytesAsync(effectiveRecord, gameRelease).GetAwaiter().GetResult());
            if (!string.Equals(effectiveBody, headBody, StringComparison.Ordinal))
                baselines.Add((formKey, headBody));
        }

        foreach (var formKey in effectiveByFormKey.Keys)
        {
            if (headFormKeys.Contains(formKey) || alreadyHandled.Contains(formKey)) continue;
            workingTreeOnly.Add(formKey);
        }
    }

    // Not Edits.SourceCheckout, which does exactly this: Source must not depend on Edits (the
    // dependency runs the other way), and duplicating this small a materialization is cheaper than a cycle.
    private static IModGetter DeserializeHeadTree(string modFolder, string pluginName)
    {
        var scratchRoot = Directory.CreateTempSubdirectory("medit-reconcile-head-").FullName;
        try
        {
            foreach (var (relativePath, bytes) in SourceRepository.EnumerateSourceAtRef(modFolder, pluginName, "HEAD"))
            {
                var destination = Path.Combine(scratchRoot, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.WriteAllBytes(destination, bytes);
            }

            var treeRoot = Path.Combine(scratchRoot, SourceRecordPath.RootFor(pluginName));
            return RecordTextCodecGeneratorSeed
                .DeserializeWholeMod(treeRoot, InlineWorkDropoff.Instance, CancellationToken.None)
                .GetAwaiter().GetResult();
        }
        finally
        {
            // Best-effort: a scratch delete failure must never mask whatever the try block threw.
            try { Directory.Delete(scratchRoot, recursive: true); }
            catch (IOException) { /* scratch, best-effort */ }
            catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
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

    // Record type from the path (the file is gone); FormKey from HEAD's document.
    private static (string FormKey, string RecordType, string Body) DeletedInWorkingTree(
        RecordTextCodec codec, GameRelease gameRelease, SourceRecordIdentity identity, string headText)
    {
        var record = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(headText), gameRelease, identity.RecordType)
            .GetAwaiter().GetResult();

        return (record.FormKey.ToString(), identity.RecordType, headText);
    }
}
