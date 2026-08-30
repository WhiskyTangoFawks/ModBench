using System.Diagnostics;
using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Source;

/// <summary>
/// #452 / ADR-0041's #444 amendment, point 2: a tracked plugin's read model is seeded from its
/// <b>source</b>, never from the compiled artifact. The working tree answers
/// <see cref="RecordRef.Effective"/>; git <c>HEAD</c> answers <see cref="RecordRef.Head"/>.
///
/// <para><b>This is a designated door</b> for the generated whole-mod mixin, alongside
/// <see cref="TrackService"/> (<see cref="RecordTextCodecGeneratorSeed"/>'s AC2 whitelist —
/// <c>RecordTextCodecGeneratorSeedTests</c> enforces which files may reach it).</para>
///
/// <para><b>Why this needs no extraction code of its own, and why that is the point.</b> The whole
/// tree deserializes to an ordinary <c>IModGetter</c>, which is exactly what
/// <see cref="IRecordIndex.Index"/> already takes — so a tracked plugin and an untracked one are
/// indexed by the same call, over the same object shape, producing the same <c>records</c>
/// documents and the same extracted tables (<c>form_lookup</c>, <c>form_references</c>,
/// <c>placement</c>, <c>cell_location</c>, <c>container_child</c>, <c>header</c>). Embedded child
/// records (placed refs, navmeshes, landscape, <c>Worldspace.TopCell</c>) fall out of that for free:
/// <c>EnumerateMajorRecords</c> walks into containers, so each child gets its own row extracted from
/// the parent document just as it does on the binary path. "Identical extracted rows between a
/// tracked and an untracked copy" is therefore a construction, not a coincidence, and
/// <c>SourceIngestParityTests</c> checks it row for row on real data rather than taking this
/// paragraph's word for it.</para>
/// </summary>
internal static class SourceIngest
{
    /// <summary>
    /// The tree to ingest <paramref name="pluginName"/> from, or <see langword="null"/> when there is
    /// none and the caller should use the binary — the plugin has no mod folder (a Data-directory
    /// master), the folder is untracked, or it is tracked but holds no source tree for <i>this</i>
    /// plugin.
    ///
    /// <para>That last case is not defensive padding: a mod folder can hold several plugins and be
    /// tracked for one of them, and a user can have their own <c>.git</c> in a mod folder that Track
    /// never touched. Re-derived on every call, never cached — the folder can be created, replaced or
    /// shell-deleted between any two reconciles (root CLAUDE.md's never-assume-exclusive-ownership
    /// rule; MO2's Replace install does exactly that).</para>
    /// </summary>
    internal static string? TreeFor(string origin, string pluginPath, string pluginName)
    {
        if (ModFolders.Of(origin, pluginPath) is not { } modFolder) return null;
        if (!SourceRepository.IsTracked(modFolder)) return null;

        var tree = Path.Combine(modFolder, SourceRecordPath.RootFor(pluginName));
        return Directory.Exists(tree) ? tree : null;
    }

    /// <summary>
    /// Reads <paramref name="sourceTree"/> whole and indexes it as <paramref name="key"/>, replacing
    /// whatever that key previously held — the source-side counterpart of indexing a binary overlay,
    /// and deliberately the same <see cref="IRecordIndex.Index"/> call.
    ///
    /// <para>Blocking on the async door is the same trade <c>DuckDbRecordIndex.AppendDocument</c>
    /// already makes for the codec: the reconcile loop is synchronous and progressive by design
    /// (#274), and making it async to match a signature that comes from Mutagen's generated
    /// serializers would push a false shape all the way up through <c>IRecordIndex</c>.</para>
    ///
    /// <para>Throws whatever the tree throws — a malformed document, a vanished directory, a locked
    /// file. The caller decides what a failed source read means for the load order; this method does not
    /// degrade on its own account, because "quietly served you the binary instead" is precisely the
    /// silent lie the caller's own visible failure exists to prevent.</para>
    /// </summary>
    /// <param name="binaryPath">The plugin's compiled binary — indexed here only as the file this
    /// key's rows are <i>stamped against</i> (#585), never as their content, which is the whole point
    /// of this class. A tracked plugin re-ingests from source on every load regardless of that stamp
    /// (<c>LoadOrderMirror.Reconcile</c> decides that); what the stamp buys is that a binary
    /// deleted or replaced out of band still takes its stale rows with it at the next validation,
    /// exactly as an untracked plugin's would.</param>
    internal static void Ingest(
        IRecordIndex index, string modFolder, string sourceTree, Registration registration,
        PluginKey key, string binaryPath, GameRelease gameRelease, SchemaReflector schemaReflector,
        ILogger logger, CancellationToken cancel = default)
    {
        var timer = Stopwatch.StartNew();
        var mod = RecordTextCodecGeneratorSeed
            .DeserializeWholeMod(sourceTree, InlineWorkDropoff.Instance, cancel)
            .GetAwaiter().GetResult();
        var deserializeMs = timer.ElapsedMilliseconds;

        timer.Restart();
        index.Index(mod, registration, key, binaryPath);
        var indexMs = timer.ElapsedMilliseconds;

        timer.Restart();
        ReconcileHead(index, modFolder, key, gameRelease, schemaReflector, logger, mod);
        // #113: per-phase load timing for the tracked-plugin ingest path.
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Ingested {Plugin} from source: deserialize {DeserializeMs} ms, index {IndexMs} ms, reconcile {ReconcileMs} ms",
                key.Name, deserializeMs, indexMs, timer.ElapsedMilliseconds);
        }
    }

    /// <summary>
    /// The second half of the ref dimension. The whole-tree read above put the <b>working tree</b> at
    /// every ref, which is right for the overwhelming majority of records and wrong for exactly the
    /// dirty ones; this moves those back onto what <c>HEAD</c> holds.
    ///
    /// <para><b>The dirty set comes from git, not from a hash compare against the index.</b> That is
    /// deliberate and it matters: <c>records.content_hash</c> is the hash of the codec's own
    /// <i>canonical</i> serialization, so comparing it against <c>HEAD</c>'s blob hash would report
    /// every record of a tree not produced by this exact codec run as modified, and then re-baseline
    /// every one of them into permanent dirt. <c>git status</c> answers the question actually being asked — does this file
    /// differ between the working tree and <c>HEAD</c> — with no canonicality assumption at all, in a
    /// single process.</para>
    ///
    /// <para><b>Clean is free.</b> An unedited tracked plugin has no dirty paths, so this returns
    /// after that one <c>git status</c> and reads no blobs at all — ADR-0041's "one parse serves both
    /// refs" fast path, and the state almost every tracked plugin in a load order is in. Cost past
    /// that is bounded by dirt, never by load order, the same bound <see cref="SourceFreshness"/>
    /// already holds itself to.</para>
    ///
    /// <para><b>#463: a container path falls through to a structural diff instead of being dropped.</b>
    /// <see cref="SourceRecordPath.TryParse"/> only understands the flat, single-file shape — it fails
    /// closed on a container's own directory (<c>Cells/&lt;b&gt;/&lt;sb&gt;/&lt;name&gt;/RecordData.json</c>,
    /// <c>Quests/&lt;n&gt;/DialogTopics/&lt;n&gt;/RecordData.json</c>) by design (ADR-0041's 2026-08-23
    /// amendment: no container-path grammar, ever — declined twice already, #453 and #454, for the same
    /// reason each time). When at least one dirty path under this plugin's own tree fails that parse,
    /// <see cref="ReconcileHeadStructurally"/> runs once for the whole call: it deserializes <c>HEAD</c>
    /// the same whole-mod way <paramref name="effectiveMod"/> already was, and diffs the two mod objects
    /// by FormKey — the same amendment's answer, needing no path identity at all. Gated on dirt exactly
    /// like the flat loop above: a clean tree never reaches this paragraph.</para>
    /// </summary>
    private static void ReconcileHead(
        IRecordIndex index, string modFolder, PluginKey key, GameRelease gameRelease,
        SchemaReflector schemaReflector, ILogger logger, IModGetter effectiveMod)
    {
        // This early-out *is* the clean fast path — and note it is a structural guarantee, not a
        // tested one. Reconciling every record instead of just the dirty ones would still produce
        // correct answers (SetCommittedBaseline is a no-op for a record whose bytes already match), so
        // no behavioural test can tell bounded from unbounded here; the only difference is how many git
        // blobs get read. Verified during #452 by applying exactly that rival and watching the suite
        // stay green. Keep the bound because it is the difference between "one git status" and "a blob
        // read per record in the load order", not because something will go red if it is lost.
        var dirty = SourceRepository.WorkingTreeStatus(modFolder);
        if (dirty.Count == 0) return;

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var baselines = new List<(string FormKey, string Body)>();
        var workingTreeOnly = new List<string>();
        var deletedInWorkingTree = new List<(string FormKey, string RecordType, string Body)>();
        var needsStructuralFallback = false;

        // Recognizes "is this dirty path under my own plugin's tree at all" — the same prefix the
        // successful-parse branch below already checks via identity.PluginFileName, just needed one
        // parse earlier here. Not a container-path grammar: it says nothing about record type or
        // position, only which plugin's own subtree the path sits under (#463; ADR-0041 amendment).
        var ownTreePrefix = $"{SourceRecordPath.RootFor(key.Name)}{Path.DirectorySeparatorChar}";

        foreach (var gitPath in dirty)
        {
            // git speaks forward slashes on every platform; SourceRecordPath splits on the platform's
            // own separator, so a raw porcelain path would simply never parse on Windows.
            var relativePath = gitPath.Replace('/', Path.DirectorySeparatorChar);

            if (!SourceRecordPath.TryParse(relativePath, gameRelease, out var identity))
            {
                // Fails closed for everything that is not a flat record file: the root RecordData.json,
                // .gitignore — and every *container* path
                // (Cells/<b>/<sb>/<name>/RecordData.json, Quests/<name>/...). Recovering a record type
                // from a container path would need a reader nothing has built, and ADR-0041's amendment
                // rules that reader out permanently — so a path under this plugin's own tree instead
                // defers to the structural pass below, once, after this loop; a path outside it (a
                // different plugin's tree in the same mod folder, .gitignore, an unrelated file) carries
                // nothing to reconcile either way and is just logged.
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

            // Absent from the working tree (a deletion) or absent from HEAD (a create) are the two
            // cases SetCommittedBaseline cannot express — they move which refs hold the record at all,
            // not merely the bytes one of them holds. Each gets its own verb.
            var fullPath = Path.Combine(modFolder, relativePath);
            var headText = SourceRepository.ReadCommittedSourceText(modFolder, relativePath);

            if (!File.Exists(fullPath))
            {
                // Deleted in the working tree. Gone at Effective already — the whole-tree read simply
                // never saw it — but it must keep answering at Head, or the user could no longer see,
                // diff or revert what they deleted, which is the centre of the git-native working-tree
                // model rather than an edge case (ADR-0041).
                if (headText != null)
                    deletedInWorkingTree.Add(DeletedInWorkingTree(codec, gameRelease, identity, headText));
                continue;
            }

            // Identity from the document, not from the path: the flat file name embeds the EditorID
            // ahead of the FormKey and an EditorID may itself legally contain " - ", which makes
            // splitting the name ambiguous in the general case (SourceRecordIdentity's doc comment).
            var record = codec.DeserializeAsync(fullPath, gameRelease, identity.RecordType).GetAwaiter().GetResult();

            if (headText == null)
            {
                // In the working tree, at no commit: a record created and not yet committed. #427's
                // write path never runs `git add`, so this is the ordinary shape of a working-tree
                // create (an untracked "??" entry), not a rare one.
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

        // Applied only once the whole dirty set has been read, never per iteration. A path that throws
        // mid-loop therefore leaves Head untouched rather than half-moved — which matters because the
        // caller's response to that throw is to re-ingest this same key from the binary, and a Head
        // snapshot surviving that rebuild would put two rows under one FormKey in `records_head`.
        // Index() clears the snapshot table for the key as well, which is the robust half of that
        // guarantee; this is the half that keeps the three head-state writes symmetrical, so the next
        // person adding a fourth does not inherit a per-iteration commit as the local idiom.
        index.SetCommittedBaseline(key, baselines);
        index.MarkWorkingTreeOnly(key, workingTreeOnly);
        index.SeedCommittedOnly(key, deletedInWorkingTree);
    }

    /// <summary>
    /// #463's structural half: deserializes <c>HEAD</c>'s own tree the same whole-mod way
    /// <paramref name="effectiveMod"/> already was, then diffs the two mod objects by FormKey —
    /// added/changed/removed, the three set operations the flat loop above expresses per-path. Needs no
    /// path identity at all (ADR-0041's 2026-08-23 amendment), which is what lets it answer for a
    /// container and an embedded child alike: <c>EnumerateMajorRecords</c> walks into both mod objects'
    /// containers the same way <see cref="IRecordIndex.Index"/>'s own ingest does, so a placed reference
    /// nested inside a Cell is just another FormKey in each dictionary below.
    ///
    /// <para><b>No SQL, no git blob read per record.</b> Both dictionaries come from mod objects already
    /// fully in memory (<paramref name="effectiveMod"/> from the caller, <c>headMod</c> freshly
    /// deserialized here), and comparison is a codec re-serialize plus a byte compare — the same
    /// operation <c>DuckDbRecordIndex.AppendDocument</c> already does for every record at ingest, not a
    /// new per-record cost class. Only the FormKeys that actually differ are handed to the three output
    /// lists, which is what keeps the DB-touching side of this (<see cref="IRecordIndex.SetCommittedBaseline"/>'s
    /// own per-record compare) bounded by genuine dirt rather than by how many records the container
    /// subtree holds.</para>
    ///
    /// <para><b>A schema-unpublished record type is skipped on the deletion side only.</b>
    /// <c>SchemaReflector</c> deliberately excludes a handful of types from the read model
    /// (<c>land</c>/<c>navm</c>/<c>navi</c>, the rare REFR-flavour placement variants) — they are never
    /// independently queryable, so seeding a Head-only row for one would create a
    /// <c>records_committed</c> entry <see cref="IRecordIndex.GetDocument(string, PluginKey)"/> could
    /// never read back. The edit and create branches need no equivalent guard: their targets
    /// (<see cref="IRecordIndex.SetCommittedBaseline"/>, <see cref="IRecordIndex.MarkWorkingTreeOnly"/>)
    /// already no-op for a FormKey the index never indexed, the same missing-data rule the flat path
    /// already relies on.</para>
    /// </summary>
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

    /// <summary>
    /// Materializes <paramref name="pluginName"/>'s tree exactly as <c>HEAD</c> holds it into a scratch
    /// directory (no checkout — the same no-checkout read <see cref="SourceRepository.EnumerateSourceAtRef"/>
    /// already gives <c>PluginCompileService</c>'s own parked-ref compile), then hands that directory to
    /// the same whole-mod door <see cref="Ingest"/> used for the working tree.
    ///
    /// <para>Deliberately not <c>Edits.SourceCheckout</c>, which already does this exact thing for
    /// compile-at-ref: reusing it would make <c>Source</c> depend on <c>Edits</c>, and today the
    /// dependency runs the other way (<c>PluginCompileService</c>/<c>RecordEditService</c> both depend on
    /// <c>Source</c>) — introducing the reverse edge would be a cycle. Duplicating this small a
    /// materialization is cheaper than that.</para>
    /// </summary>
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
            // Best-effort, mirroring SourceCheckout.Dispose's own guard: a scratch directory this
            // process itself created and is done with, so a delete failure here (another process
            // still touching it, permissions) is never worth letting mask whatever the try block
            // actually threw.
            try { Directory.Delete(scratchRoot, recursive: true); }
            catch (IOException) { /* scratch, best-effort */ }
            catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
        }
    }

    /// <summary>
    /// Folds a <b>renamed</b> source unit's two halves back into the one record it is (#453 slice 4).
    ///
    /// <para>An EditorID edit moves the source unit's file, because the file name carries the EditorID
    /// (<c>RecordEditService.RenameSourceUnit</c>). The dirty set then holds the same FormKey twice:
    /// the old path, absent from the working tree but present in <c>HEAD</c>, which the loop above
    /// classified as a deletion; and the new path, present in the working tree and in no commit, which
    /// it classified as a create. Left that way the record would be handed to
    /// <see cref="IRecordIndex.MarkWorkingTreeOnly"/> and <see cref="IRecordIndex.SeedCommittedOnly"/>
    /// at once — one FormKey in <i>both</i> halves of <c>records_head</c>, which is exactly the
    /// disjointness #452's review commit landed to protect, and which would leave the record answering
    /// twice at Head.</para>
    ///
    /// <para>What it actually is is an ordinary dirty record: the working tree holds the new bytes, and
    /// <c>HEAD</c> holds the old ones at the old path. That is a committed baseline, so the pair
    /// collapses into <paramref name="baselines"/> and leaves both other lists.</para>
    ///
    /// <para><b>Only flat records reach this pairing.</b> A flat record's own file name carries its
    /// EditorID, so a rename shows up as this exact create+delete pair; <see cref="SourceRecordPath.TryParse"/> fails
    /// closed on container paths, so a renamed container's two file-system halves never reach this
    /// method at all. That is not the same as "a renamed container's Head goes unreconciled", though —
    /// #463's structural pass (<see cref="ReconcileHeadStructurally"/>) diffs by FormKey, not by path, so
    /// a container rename lands there as an ordinary edit (old bytes at Head, new bytes at Effective,
    /// same FormKey throughout) without ever needing this pairing step.</para>
    /// </summary>
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

    /// <summary>Re-seeds a working-tree-deleted record's committed side from <c>HEAD</c>'s own bytes,
    /// so it answers at Head and nowhere else. The record type comes from the path (the file is gone,
    /// so there is nothing in the working tree to read it off) and the FormKey from <c>HEAD</c>'s
    /// document, which is the same "identity comes from the document" rule the live branch follows.</summary>
    private static (string FormKey, string RecordType, string Body) DeletedInWorkingTree(
        RecordTextCodec codec, GameRelease gameRelease, SourceRecordIdentity identity, string headText)
    {
        var record = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(headText), gameRelease, identity.RecordType)
            .GetAwaiter().GetResult();

        return (record.FormKey.ToString(), identity.RecordType, headText);
    }
}
