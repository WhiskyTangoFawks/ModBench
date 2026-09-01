using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// ADR-0041's tracked-source amendment, point 2: "Tracked plugins ingest from source. Working tree →
/// Effective, git <c>HEAD</c> → Head; the binary is never consulted for a tracked plugin's content."
///
/// <para>Every test here reloads the mod folder in a <b>brand-new</b> <see cref="LoadOrderMirror"/> —
/// the only honest way to ask what reconcile itself ingests, rather than what some earlier
/// in-load order gesture left behind. And every assertion reads the raw <see cref="IRecordIndex"/>,
/// never <c>RecordQueryService</c>: the latter drives <c>SourceFreshness</c>'s read-time self-heal,
/// which would fold the source file in on the first read and make a binary-seeded ingest look
/// source-seeded. The point of this suite is that no point-read trigger is needed at all.</para>
/// </summary>
public sealed class SourceIngestTests
{
    /// <summary>A fresh load order over the same mod folder — a backend restart, in effect.</summary>
    private static LoadOrderMirror Reload(TrackedModFixture mod)
    {
        var mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)mirror).Reconcile(
            mod.GameDirectory,
            [new LoadOrderEntry(TrackedModFixture.PluginName, Path.Combine(mod.ModFolder, TrackedModFixture.PluginName), TrackedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        return mirror;
    }

    // ---- The working tree is Effective ----

    [Fact]
    public void AnExternalEditToASourceFile_IsAtEffectiveAfterReload_WithNoPointRead()
    {
        using var mod = TrackedModFixture.Tracked();

        // A hand edit outside Modbench — the user's own editor, an agent's script, a git checkout.
        // Nothing tells the backend it happened; the next reconcile is simply expected to read it.
        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(mod);

        var record = reloaded.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(record);
        Assert.Equal("ExternallyRenamed", record!.EditorId);
    }

    // ---- The reappearing-record gap, resolved by construction ----

    [Fact]
    public void AWorkingTreeDeletedRecord_IsAbsentAtEffectiveAfterReload()
    {
        using var mod = TrackedModFixture.Tracked();

        File.Delete(mod.NpcSourceFile);

        using var reloaded = Reload(mod);

        Assert.Null(reloaded.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin));
        // Positive control: the load really happened and really indexed this plugin, or "absent"
        // would be true of a load that did nothing at all.
        Assert.NotNull(reloaded.Index!.At(RecordRef.Effective).GetDocument(mod.OtherNpc.ToString(), mod.Plugin));
    }

    /// <summary>
    /// The other half of the same deletion, and the reason it is not enough to simply leave the record
    /// out of the ingest: <c>HEAD</c> still holds it, so Head must still answer it. Without this the
    /// user could delete a record and then no longer see, diff or revert it — which is the centre of
    /// ADR-0041's git-native working-tree model, not an edge case.
    /// </summary>
    [Fact]
    public void AWorkingTreeDeletedRecord_StillAnswersAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        File.Delete(mod.NpcSourceFile);

        using var reloaded = Reload(mod);

        var head = reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal(TrackedModFixture.NpcEditorId, head!.EditorId);
        // The Head row is HEAD's own bytes, not a reconstruction: same text `git show` serves.
        Assert.Equal(mod.GitShowHead(mod.RelativeSourcePath(
            mod.Npc, "npc_", TrackedModFixture.NpcEditorId)), head.Body);
    }

    // ---- HEAD is Head, the working tree is Effective, and they diverge ----

    [Fact]
    public void AnUncommittedEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        using var mod = TrackedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(mod);

        Assert.Equal("ExternallyRenamed", reloaded.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
        Assert.Equal(
            TrackedModFixture.NpcEditorId,
            reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
    }

    [Fact]
    public void AnEditCommittedOutsideModbench_LeavesBothRefsOnTheNewBytes_NotPermanentlyDirty()
    {
        using var mod = TrackedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "CommittedRename", StringComparison.Ordinal));
        var gitDir = Path.Combine(mod.ModFolder, ".git");
        GitCli.Run(gitDir, mod.ModFolder, "add", "-A");
        GitCli.Run(gitDir, mod.ModFolder, "commit", "-q", "-m", "external rename");

        using var reloaded = Reload(mod);

        // HEAD moved with the working tree, so the record is clean against its *new* baseline —
        // not dirty against a baseline no ref holds any more.
        Assert.Equal("CommittedRename", reloaded.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
        Assert.Equal(
            "CommittedRename",
            reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
    }

    /// <summary>
    /// Reconciliation is <i>targeted</i>: the record whose file was edited reads dirty and its
    /// untouched sibling reads clean. Asserted at the listing seam (<see cref="RecordSummary.WorkingTreeState"/>
    /// — what the Plugins tree's own dirty decoration renders) rather than by comparing two
    /// bodies, because "the two refs happen to hold equal bytes" is true of a great many wrong
    /// implementations, while "one is Modified and the other is None" is the distinction the ref
    /// dimension actually exists to make.
    /// </summary>
    [Fact]
    public void ReconcilingOneEditedRecord_LeavesItsUntouchedSiblingClean()
    {
        using var mod = TrackedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(mod);

        var byFormKey = reloaded.Index!
            .At(RecordRef.Effective).Search(new RecordQuery { Plugin = TrackedModFixture.PluginName, Limit = 100 })
            .Items.ToDictionary(r => r.FormKey, StringComparer.Ordinal);

        Assert.Equal(WorkingTreeState.Modified, byFormKey[mod.Npc.ToString()].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[mod.OtherNpc.ToString()].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[mod.Race.ToString()].WorkingTreeState);
    }

    // ---- A source tree that cannot be read degrades to the binary, visibly ----

    [Fact]
    public void AnUnreadableSourceTree_FallsBackToTheBinary_AndSaysSoInTheFailures()
    {
        using var mod = TrackedModFixture.Tracked();

        // Never-assume-exclusive-ownership: MO2, a git operation, or the user can leave this tree
        // half-written at any moment. The root header is what the whole-mod door reads first.
        File.WriteAllText(
            Path.Combine(mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "RecordData.json"),
            "{ this is not json");

        using var reloaded = Reload(mod);

        // Degraded, not dropped — the plugin's records are still queryable from the binary.
        Assert.NotNull(reloaded.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin));

        // ...and the degradation is *visible*, which is the whole mitigation: a user reading
        // pre-Track binary content while believing they are reading their tracked source is the hazard.
        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(TrackedModFixture.PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// <b>The invariant: <c>records_head</c>'s two halves are disjoint</b> — a FormKey answers at Head
    /// either from a <c>records_committed</c> snapshot or from a still-clean <c>records</c> row, never
    /// both. <c>TableDdlBuilder</c> states it as true "by construction", and its <c>UNION ALL</c>
    /// (deliberately not <c>UNION</c>) depends on exactly that.
    ///
    /// <para>Ingest-from-source is the first thing able to break it, because it is the first operation
    /// that calls <see cref="IRecordIndex.Index"/> and writes <c>records_committed</c> for one key,
    /// with a failure path that calls <c>Index</c> on that same key <i>again</i>. A working-tree
    /// deletion early in the dirty set commits a snapshot row; a later dirty path throws; the binary
    /// fallback rebuilds <c>records</c> — and <c>Index</c>/<c>Unindex</c> have never cleared
    /// <c>records_committed</c>. Two rows, one FormKey.</para>
    ///
    /// <para>Deliberately a different failure from the test above: corrupting the root
    /// <c>RecordData.json</c> makes the whole-mod read throw <i>before</i> any snapshot can be written,
    /// so it cannot reach this at all. The failure here is a path whose <c>HEAD</c> blob is unreadable
    /// and whose working-tree copy is gone — an ordinary never-assume-exclusive-ownership state that
    /// lands after the deletion branch has already committed.</para>
    /// </summary>
    [Fact]
    public void APartialReconcileThenBinaryFallback_LeavesExactlyOneRowAtHead_NotTwo()
    {
        using var mod = TrackedModFixture.Tracked();
        var gitDir = Path.Combine(mod.ModFolder, ".git");
        var sourceRoot = Path.Combine(mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName));

        // A committed file the per-record codec cannot read back. "Npcs" sorts after "Keywords" and git
        // orders porcelain output by path, so the good deletion below is processed first.
        var poison = Path.Combine(sourceRoot, "Npcs", "zzbroken.json");
        File.WriteAllText(poison, "{ not a record");
        GitCli.Run(gitDir, mod.ModFolder, "add", "-A");
        GitCli.Run(gitDir, mod.ModFolder, "commit", "-q", "-m", "commit an unreadable record");

        // Two working-tree deletions. The first re-seeds Head and commits; the second throws when its
        // HEAD blob is parsed, aborting the ingest partway through the dirty set.
        File.Delete(Path.Combine(mod.ModFolder, mod.RelativeSourcePath(
            mod.Keyword, "kywd", TrackedModFixture.KeywordEditorId)));
        File.Delete(poison);

        using var reloaded = Reload(mod);

        // Precondition: the ingest really did fail partway and fall back, or this proves nothing.
        Assert.NotEmpty(reloaded.Status.Failures);

        var atHead = reloaded.Index!.At(RecordRef.Head)
            .Search(new RecordQuery(Plugin: mod.Plugin, Limit: int.MaxValue))
            .Items.Count(r => string.Equals(r.FormKey, mod.Keyword.ToString(), StringComparison.Ordinal));

        Assert.Equal(1, atHead);
    }

    // ---- A renamed source unit is one dirty record, not two half-records ----

    /// <summary>
    /// An EditorID edit moves the source unit's file, so the next reconcile sees the same FormKey
    /// twice in the dirty set: the old path, gone from the working tree but present in <c>HEAD</c>, and
    /// the new path, present in the working tree and in no commit. Reconciled naively those are a
    /// delete and a create — which would put one FormKey in <b>both</b> halves of <c>records_head</c>,
    /// breaking the disjointness invariant above. Paired, they are what they actually are:
    /// one record, dirty, whose committed bytes are the ones at its old path.
    ///
    /// <para>Flat record on the shared fixture deliberately: this is a property of the reconciliation
    /// pass, not of containers, and the ~24 files built on this fixture should see it. A renamed
    /// <i>container</i> never reaches this same pairing step — <see cref="SourceRecordPath.TryParse"/>
    /// still fails closed on container paths — but it is not left unreconciled either:
    /// <c>SourceIngest.ReconcileHeadStructurally</c> diffs by FormKey rather than by path, so a
    /// container's directory rename (its own EditorID edit) lands there as an ordinary edit, old bytes
    /// at Head and new at Effective under the one FormKey throughout, with no pairing needed at
    /// all.</para>
    /// </summary>
    [Fact]
    public void AnEditorIdRename_ReadsAsOneDirtyRecordAfterReload_NotACreateAndADelete()
    {
        using var mod = TrackedModFixture.Tracked();

        var edit = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(mod.Plugin, mod.Npc.ToString(), "editor_id",
                JsonDocument.Parse("\"RenamedAcrossReload\"").RootElement);
        Assert.True(edit.Applied, edit.Message);

        using var reloaded = Reload(mod);

        // Effective is the working tree: the new name.
        var effective = reloaded.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedAcrossReload", effective!.EditorId);

        // Head is HEAD: the old name, served from the blob at the record's *former* path. Without the
        // pairing this is null — the new path marks the record working-tree-only, which removes it
        // from Head entirely — while the old path simultaneously seeds it as committed-only.
        var head = reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal(TrackedModFixture.NpcEditorId, head!.EditorId);
    }

    /// <summary>The disjointness invariant itself, stated directly rather than inferred from the two
    /// reads above: <c>records_head</c> must answer for a FormKey exactly once. A rename that landed in
    /// both halves would return two rows here, which is the shape
    /// <c>HeadRelationDisjointnessTests</c> exists to forbid in general.</summary>
    [Fact]
    public void AnEditorIdRename_LeavesExactlyOneRowAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(mod.Plugin, mod.Npc.ToString(), "editor_id",
                JsonDocument.Parse("\"RenamedOnce\"").RootElement);

        using var reloaded = Reload(mod);

        var atHead = reloaded.Index!.At(RecordRef.Head)
            .Search(new RecordQuery(Plugin: mod.Plugin, Limit: int.MaxValue))
            .Items.Count(r => string.Equals(r.FormKey, mod.Npc.ToString(), StringComparison.Ordinal));

        Assert.Equal(1, atHead);
    }
}
