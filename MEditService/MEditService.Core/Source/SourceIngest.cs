using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
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
    /// shell-deleted between any two session loads (root CLAUDE.md's never-assume-exclusive-ownership
    /// rule; MO2's Replace install does exactly that).</para>
    /// </summary>
    internal static string? TreeFor(string origin, string pluginPath, string pluginName)
    {
        if (ModFolders.Of(origin, pluginPath) is not { } modFolder) return null;
        if (!SourceRepository.IsTracked(modFolder)) return null;

        var tree = Path.Combine(modFolder, $"{pluginName}{SourceRecordPath.SourceSuffix}");
        return Directory.Exists(tree) ? tree : null;
    }

    /// <summary>
    /// Reads <paramref name="sourceTree"/> whole and indexes it as <paramref name="key"/>, replacing
    /// whatever that key previously held — the source-side counterpart of indexing a binary overlay,
    /// and deliberately the same <see cref="IRecordIndex.Index"/> call.
    ///
    /// <para>Blocking on the async door is the same trade <c>DuckDbRecordIndex.AppendDocument</c>
    /// already makes for the codec: the session-load loop is synchronous and progressive by design
    /// (#274), and making it async to match a signature that comes from Mutagen's generated
    /// serializers would push a false shape all the way up through <c>IRecordIndex</c>.</para>
    ///
    /// <para>Throws whatever the tree throws — a malformed document, a vanished directory, a locked
    /// file. The caller decides what a failed source read means for the session; this method does not
    /// degrade on its own account, because "quietly served you the binary instead" is precisely the
    /// silent lie the caller's own visible failure exists to prevent.</para>
    /// </summary>
    internal static void Ingest(
        IRecordIndex index, string modFolder, string sourceTree, int loadOrderIndex, bool participates,
        PluginKey key, GameRelease gameRelease, ILogger logger, CancellationToken cancel = default)
    {
        var mod = RecordTextCodecGeneratorSeed
            .DeserializeWholeMod(sourceTree, InlineWorkDropoff.Instance, cancel)
            .GetAwaiter().GetResult();

        index.Index(mod, loadOrderIndex, participates, key);
        ReconcileHead(index, modFolder, key, gameRelease, logger);
    }

    /// <summary>
    /// The second half of the ref dimension. The whole-tree read above put the <b>working tree</b> at
    /// every ref, which is right for the overwhelming majority of records and wrong for exactly the
    /// dirty ones; this moves those back onto what <c>HEAD</c> holds.
    ///
    /// <para><b>The dirty set comes from git, not from a hash compare against the index.</b> That is
    /// deliberate and it matters: <c>records.content_hash</c> is the hash of the codec's own
    /// <i>canonical</i> serialization, so comparing it against <c>HEAD</c>'s blob hash would report
    /// every record of an interchange tree (one stock Spriggit wrote, whose bytes differ from ours by
    /// the parity gate's named allowlist) as modified, and then re-baseline every one of them into
    /// permanent dirt. <c>git status</c> answers the question actually being asked — does this file
    /// differ between the working tree and <c>HEAD</c> — with no canonicality assumption at all, in a
    /// single process.</para>
    ///
    /// <para><b>Clean is free.</b> An unedited tracked plugin has no dirty paths, so this returns
    /// after that one <c>git status</c> and reads no blobs at all — ADR-0041's "one parse serves both
    /// refs" fast path, and the state almost every tracked plugin in a load order is in. Cost past
    /// that is bounded by dirt, never by load order, the same bound <see cref="SourceFreshness"/>
    /// already holds itself to.</para>
    /// </summary>
    private static void ReconcileHead(
        IRecordIndex index, string modFolder, PluginKey key, GameRelease gameRelease, ILogger logger)
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

        foreach (var gitPath in dirty)
        {
            // git speaks forward slashes on every platform; SourceRecordPath splits on the platform's
            // own separator, so a raw porcelain path would simply never parse on Windows.
            var relativePath = gitPath.Replace('/', Path.DirectorySeparatorChar);

            if (!SourceRecordPath.TryParse(relativePath, gameRelease, out var identity))
            {
                // Fails closed for everything that is not a flat record file: the root RecordData.json,
                // the Spriggit sidecars, .gitignore — and every *container* path
                // (Cells/<b>/<sb>/<name>/RecordData.json, Quests/<name>/...). A container's Head
                // divergence is genuinely out of reach here: recovering a record type from a container
                // path needs the structure-aware reader #453/#454 own, since a Quest's own directory
                // and its DialogTopics children share a group-folder segment and position alone cannot
                // tell them apart. Logged rather than silently dropped, so the gap stays observable.
                logger.LogDebug(
                    "Not a flat source record, so its Head state is not reconciled at load: {Path}", gitPath);
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
                if (headText != null) DeletedInWorkingTree(index, codec, key, gameRelease, identity, headText);
                continue;
            }

            // Identity from the document, not from the path: the flat file name embeds the EditorID
            // ahead of the FormKey and an EditorID may itself legally contain " - ", which makes
            // splitting the name ambiguous in the general case (SourceRecordIdentity's doc comment).
            var record = codec.DeserializeAsync(fullPath, gameRelease, identity.RecordType).GetAwaiter().GetResult();

            if (headText == null)
            {
                // In the working tree, at no commit: a record created and not yet committed. #427's
                // write path never runs `git add`, so this is the ordinary shape of a pending create
                // (an untracked "??" entry), not a rare one.
                workingTreeOnly.Add(record.FormKey.ToString());
                continue;
            }

            baselines.Add((record.FormKey.ToString(), headText));
        }

        index.SetCommittedBaseline(key, baselines);
        index.MarkWorkingTreeOnly(key, workingTreeOnly);
    }

    /// <summary>Re-seeds a working-tree-deleted record's committed side from <c>HEAD</c>'s own bytes,
    /// so it answers at Head and nowhere else. The record type comes from the path (the file is gone,
    /// so there is nothing in the working tree to read it off) and the FormKey from <c>HEAD</c>'s
    /// document, which is the same "identity comes from the document" rule the live branch follows.</summary>
    private static void DeletedInWorkingTree(
        IRecordIndex index, RecordTextCodec codec, PluginKey key, GameRelease gameRelease,
        SourceRecordIdentity identity, string headText)
    {
        var record = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(headText), gameRelease, identity.RecordType)
            .GetAwaiter().GetResult();

        index.SeedCommittedOnly(key, record.FormKey.ToString(), identity.RecordType, headText);
    }
}
