using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>
/// Read-time freshness validation: before the record editor or compare
/// grid answers for a FormKey, the source text those answers claim to reflect is re-checked, and
/// anything that moved out of band is folded in.
///
/// <para><b>Why read time and not a watcher.</b> Modbench owns the <c>.git</c> folder, so git itself
/// is the change source — <c>git restore</c> from the Source Control panel, a checkout, a rebase, a
/// terminal commit, a hand edit, an agent's script. None of those notify anybody, and a filesystem
/// watcher would still miss the ones that move <c>HEAD</c> without touching a file. Validating where
/// the answer is produced is the only place that catches all of them, and it costs nothing on the
/// overwhelmingly common path (see below).</para>
///
/// <para><b>Both refs are re-derived, never just the working-tree side.</b> After an external commit
/// "committed" itself has moved: refreshing only Effective would leave Head serving bytes no ref
/// holds any more, and the record reading as permanently dirty against a baseline that no longer
/// exists. So the pass asks two independent questions — does the file still match what the index
/// serves at Effective, and does <c>HEAD</c> still hold the bytes the index calls committed.</para>
///
/// <para><b>The cost is bounded by dirt, not by load order.</b> The file compare is a small read per
/// record of the FormKey being looked at. git is consulted only for records the index already
/// believes are dirty — for a clean record the stored committed bytes, the file and <c>HEAD</c> agree
/// by construction, so there is nothing a git call could discover. In a load order where nothing has
/// been edited, this pass runs no git processes at all.</para>
///
/// <para>A <c>content_hash</c> mismatch is never treated as proof of a user edit — it routes to a
/// byte compare, which decides (<see cref="GitBlobHash"/>'s one-directional contract).</para>
///
/// <para><b>Covers only moves made while the backend runs.</b> Ingest-from-source
/// (<see cref="SourceIngest"/>) seeds both refs from the tree, so at load time there is nothing here
/// to correct; every method below is the re-check for a file that moves <i>after</i> the load order
/// is up (a <c>git restore</c> from the Source Control panel, a terminal commit, an agent's script),
/// which no ingest can anticipate.</para>
/// </summary>
public sealed class SourceFreshness(ILoadOrderMirror mirror, ILogger<SourceFreshness> logger, RecordTextCodec codec)
{
    // The per-record codec RecordEditService already writes through — needed here because an
    // embedded child's own body has to be extracted out of its owner's document rather than
    // read straight off a file (see RecordBodyFromOwnerBytes). DI-constructed like the rest of this
    // class — RecordTextCodec is already an AddSingleton in Program.cs, so this is
    // just threading the primary constructor's own parameter through rather than a second,
    // hand-rolled instance bypassing it.
    private readonly RecordTextCodec _codec = codec;

    /// <summary>
    /// Re-validates every tracked plugin's copy of <paramref name="formKey"/>. Safe to call for an
    /// unknown FormKey, an untracked plugin or with no backend running loaded — each is simply nothing to do,
    /// never a failure: this runs on the read path, and a read must not start throwing because a mod
    /// folder was deleted while the editor was open.
    /// </summary>
    public void Validate(string formKey)
    {
        var index = mirror.Index;
        var loadOrder = mirror.LoadOrder;
        if (index == null || loadOrder == null) return;

        var stack = index.GetOverrideStack(formKey);
        if (stack == null) return;

        // The plugin header is skipped, and skipping it is the *safe* answer rather than a gap.
        // Since #631 it carries a real body, so it reaches this pass for the first time — but its
        // source file is the tree's root RecordData.json, which SourceUnitResolver cannot locate (no
        // group folder, not a placement, and no FormKey in the filename for the fallback scan).
        // Without this guard the pass resolves nothing, reads that as "the user deleted this record",
        // and folds a working-tree deletion of the header into the index on an ordinary read —
        // verified, not theorised: ReadTimeFreshnessTests.
        // ReadingATrackedPluginsHeader_DoesNotFoldADeletionIntoTheIndex fails with the header's very
        // first GetRecord returning null when this line is removed.
        //
        // This restores exactly the behaviour the header had before it carried a body (the pass was
        // inert for it then too — a null file text matched its null body). Genuinely validating the
        // header against its own file needs the header to become a first-class source unit, which is
        // its own ticket, not something to fake here.
        if (stack.RecordType == HeaderIndexer.RecordType) return;

        foreach (var entry in stack.Entries)
        {
            try
            {
                ValidateOne(index, loadOrder, entry, stack.RecordType, formKey);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or NotSupportedException)
            {
                // A read must degrade to "serve what we have", never fail, when the source cannot be
                // consulted — the folder vanished mid-read, the file is locked by another tool, git
                // is mid-rebase, or the tree is corrupt (AmbiguousSourceUnitException: more than one
                // file on disk claims this FormKey). ValidateOne resolves through the general
                // SourceUnitResolver.Resolve, so a container or embedded record has no routine
                // reason to land here; this catch stays for the genuinely exceptional cases above.
                // Logged rather than swallowed (modbench/CLAUDE.md: no silent catch).
                logger.LogWarning(ex,
                    "Could not validate source freshness for {FormKey} in {Plugin}; serving the indexed state",
                    formKey, entry.Plugin.Name);
            }
        }
    }

    private void ValidateOne(
        IRecordIndex index, ILoadOrder loadOrder, OverrideStackEntry entry, string recordType, string formKey)
    {
        if (ModFolders.TrackedOf(loadOrder, entry.Plugin) is not { } modFolder) return;

        var release = loadOrder.GameRelease;

        // Through the general SourceUnitResolver.Resolve rather than the flat-only
        // FlatSourcePath — the same resolver RecordEditService already writes through. This is what
        // covers a Quest/Cell/Worldspace (a directory-per-record container, own file, no flat path to
        // compute) and an embedded child (a placed reference, a landscape, a navmesh, a Worldspace's
        // top cell — no file of its own at all): FlatSourcePath throws NotSupportedException
        // for both, which the caller's catch would turn into "serving the indexed state" — i.e. no
        // freshness check at all for either shape. Resolve also carries FlatSourcePath's own
        // EditorID-drift tolerance for the flat case.
        var unit = SourceUnitResolver.Resolve(
            index, entry.Plugin, modFolder, formKey, recordType, entry.Effective.EditorId, release);

        // Nothing on disk claims this record and the index names no container that would either — the
        // same "genuinely absent" conclusion the flat path already reached when File.Exists came back
        // false on its computed guess, just with no path left even to guess at.
        string? fileText = null;
        if (unit is { } resolved)
        {
            var ownerBytes = File.Exists(resolved.FullPath) ? File.ReadAllBytes(resolved.FullPath) : null;
            fileText = RecordBodyFromOwnerBytes(ownerBytes, resolved, formKey, release);
        }

        if (!string.Equals(fileText, entry.Effective.Body, StringComparison.Ordinal))
        {
            // The file is the source for a tracked plugin, so whatever it says now is Effective —
            // including a null, which now genuinely is the record's file having been deleted rather
            // than merely not being where its indexed EditorID said it would be. ApplyWorkingTreeChanges
            // decides for itself whether that is a change or a convergence back to committed.
            index.ApplyWorkingTreeChanges(entry.Plugin, [(formKey, fileText)]);
            // A read-time self-heal is still a mutation — the row it just folded in can newly
            // (or no longer) match an active filter, same as an explicit edit would.
            mirror.ReapplyFilter();
            if (logger.IsEnabled(LogLevel.Debug))
            {
                logger.LogDebug(
                    "Source text for {FormKey} in {Plugin} changed outside Modbench; refreshed at read time",
                    formKey, entry.Plugin.Name);
            }
        }

        // Nothing left to ask git about when Resolve found no unit at all — fail closed rather than
        // consulting a path that was never real.
        if (unit is { } resolvedUnit)
            RebaselineIfHeadMoved(index, entry, modFolder, resolvedUnit, formKey, release);
    }

    /// <summary>
    /// A record's own canonical text, from the bytes of the file <see cref="SourceUnitResolver.Resolve"/>
    /// found. For a flat record or a directory-per-record container (<paramref name="unit"/>'s own
    /// file already holds nothing but this record's own fields) that is simply the file's bytes. For
    /// an embedded child — a placed reference, a landscape, a navmesh, a Worldspace's top cell, the
    /// only shapes Spriggit actually serializes inline (<see cref="ContainerChildFields"/>'s own doc
    /// comment: its containment table is deliberately wider than the set that serializes this way) —
    /// <paramref name="ownerBytes"/> is the <i>owner's</i> whole document, not this record's own text,
    /// so the owner is deserialized, the child located the same way
    /// <see cref="Edits.RecordEditService.EditField"/> already does it
    /// (<see cref="ContainerChildFields.FindEmbeddedChild"/>), and only the child's own bytes are
    /// reserialized and returned. Comparing the owner's whole file to the child's own committed body
    /// directly — the bug this method exists to avoid reintroducing — would misdiagnose every read of
    /// an embedded child as changed, and would fold the owner's entire file into the index as if it
    /// were the child's own document.
    /// </summary>
    /// <returns>Null when <paramref name="ownerBytes"/> is null (nothing on disk), or when the owner's
    /// document no longer carries this child at all — a genuine deletion, not a resolution
    /// failure.</returns>
    private string? RecordBodyFromOwnerBytes(byte[]? ownerBytes, SourceUnit unit, string formKey, GameRelease release)
    {
        if (ownerBytes == null) return null;

        // File.ReadAllText strips a
        // leading UTF-8 BOM via StreamReader's own byte-order-mark detection; reading raw bytes here
        // instead does not, so a BOM-carrying source file (a plausible external touch — some editors
        // write one by default) would otherwise mismatch the codec's own BOM-free serialization on
        // every single read, forever, since the "fix" a self-heal would apply (writing the BOM'd text
        // into the index as Effective) never actually converges with committed. Stripped once here,
        // on the raw bytes, so every path below — the flat return and the embedded deserialize — sees
        // exactly what File.ReadAllText would have.
        ownerBytes = StripUtf8Bom(ownerBytes);

        if (!unit.IsEmbedded) return Encoding.UTF8.GetString(ownerBytes);

        var owner = _codec.DeserializeFromBytesAsync(ownerBytes, release, unit.OwnerRecordType).GetAwaiter().GetResult();
        if (ContainerChildFields.FindEmbeddedChild(owner, formKey) is not { } found) return null;

        var childBytes = _codec.SerializeToBytesAsync(found.Child, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(childBytes);
    }

    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    private static byte[] StripUtf8Bom(byte[] bytes) =>
        bytes.AsSpan(0, Math.Min(bytes.Length, Utf8Bom.Length)).SequenceEqual(Utf8Bom) ? bytes[Utf8Bom.Length..] : bytes;

    /// <summary>
    /// The second question: has <c>HEAD</c> moved past what the index calls committed. Asked only for
    /// a record the index already believes is dirty — for a clean one the committed bytes are the
    /// file's bytes, which the compare above has just confirmed, so there is nothing to find and no
    /// git process is started.
    ///
    /// <para><paramref name="unit"/> rather than a bare relative path, so this can tell a record's
    /// own file from an embedded child's owner file — <see cref="SourceUnit.RelativePath"/> names the
    /// git-tracked file either way, but for an embedded child that file's committed blob is the
    /// <i>owner's</i> whole document, not this record's own committed bytes, and needs the same
    /// owner-then-child extraction <see cref="RecordBodyFromOwnerBytes"/> already does for the
    /// working tree side.</para>
    /// </summary>
    private void RebaselineIfHeadMoved(
        IRecordIndex index, OverrideStackEntry entry, string modFolder, SourceUnit unit, string formKey,
        GameRelease release)
    {
        var head = index.At(RecordRef.Head).GetDocument(formKey, entry.Plugin);
        if (head?.Body is not { } committedBody) return;

        var relativePath = unit.RelativePath;

        // The hash fast path only means anything for a record's own file. For an embedded child the
        // git blob at relativePath is the *owner's* whole document, whose hash can never equal a hash
        // of just this child's own committed bytes — comparing them would never short-circuit
        // correctly, so it is skipped rather than asked a question it can never usefully answer.
        if (!unit.IsEmbedded)
        {
            var hashes = SourceRepository.CommittedSourceHashes(modFolder, [relativePath]);
            if (hashes == null || !hashes.TryGetValue(relativePath.Replace('\\', '/'), out var headHash)) return;

            // Hash equality is conclusive (identical bytes), which is exactly the direction relied on
            // here: equal means HEAD still holds what the index calls committed, so there is nothing
            // to do. Inequality only sends us to fetch the real text and compare bytes — never on its
            // own an assertion that anything changed.
            if (headHash == GitBlobHash.Of(Encoding.UTF8.GetBytes(committedBody))) return;
        }

        if (SourceRepository.ReadCommittedSourceText(modFolder, relativePath) is not { } headOwnerText) return;

        // The same BOM defence as RecordBodyFromOwnerBytes, at the string level — a
        // committed blob carrying a BOM is no less plausible than a working-tree file carrying one,
        // and this text feeds the same comparison against a BOM-free committedBody. \uFEFF rather
        // than a literal character in source, which an editor or a diff tool can silently mangle.
        headOwnerText = headOwnerText.TrimStart('\uFEFF');

        // For a record's own file the owner text already *is* this record's committed text. For an
        // embedded child it is the owner's whole document, so the child's own bytes are extracted out
        // of it the same way the working-tree side is — a null result here means the owner's HEAD copy
        // no longer carries this child at all, which this pass has no basis to act on any further than
        // leaving the existing committed baseline alone (the same fail-closed posture every other null
        // guard in this class takes).
        var headText = unit.IsEmbedded
            ? RecordBodyFromOwnerBytes(Encoding.UTF8.GetBytes(headOwnerText), unit, formKey, release)
            : headOwnerText;
        if (headText is not { } resolvedHeadText) return;
        if (string.Equals(resolvedHeadText, committedBody, StringComparison.Ordinal)) return;

        index.SetCommittedBaseline(entry.Plugin, [(formKey, resolvedHeadText)]);
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "HEAD moved under {FormKey} in {Plugin}; committed baseline re-established at read time",
                formKey, entry.Plugin.Name);
        }
    }
}
