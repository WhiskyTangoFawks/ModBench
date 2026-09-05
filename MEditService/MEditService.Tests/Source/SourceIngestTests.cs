using System.Text;
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
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>Every test reads the raw <c>IRecordIndex</c>, never <c>RecordQueryService</c>: its read-time
/// self-heal would make a binary-seeded ingest look source-seeded.</summary>
public sealed class SourceIngestTests
{
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
    public void AnUncommittedHeaderEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        using var mod = TrackedModFixture.Tracked();
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(TrackedModFixture.PluginName));
        var headerPath = Path.Combine(mod.ModFolder, "source", TrackedModFixture.PluginName, "RecordData.json");

        // Rebuilt through the same door the production path uses, never a hand-spliced JSON string: the
        // whole-mod door's reader is not a generic JSON parser, so a raw text edit cannot promise a
        // byte-for-byte round trip.
        var edited = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        edited.ModHeader.Author = "RenamedByHand";
        File.WriteAllBytes(headerPath, HeaderDocument.Write(edited));

        using var reloaded = Reload(mod);

        var effective = reloaded.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, mod.Plugin);
        var head = reloaded.Index!.At(RecordRef.Head).GetDocument(headerFormKey, mod.Plugin);

        Assert.NotNull(effective);
        Assert.NotNull(head);
        Assert.Contains("RenamedByHand", effective!.Body!, StringComparison.Ordinal);
        Assert.DoesNotContain("RenamedByHand", head!.Body!, StringComparison.Ordinal);
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

    // ---- The named source re-ingest door ----

    [Fact]
    public void ReingestPluginFromSource_ReDerivesFromTheMovedSourceTree_UnderALiveLoadOrder()
    {
        using var mod = TrackedModFixture.Tracked();

        var before = mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin)!;
        Assert.Equal(TrackedModFixture.NpcEditorId, before.EditorId);

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        ((ILoadOrderMirror)mod.Mirror).ReingestPluginFromSource(mod.Plugin);

        var after = mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin)!;
        Assert.Equal("ExternallyRenamed", after.EditorId);
    }

    [Fact]
    public void ReingestPluginFromSource_OnAnUntrackedPlugin_Throws()
    {
        using var mod = TrackedModFixture.Untracked();

        Assert.Throws<InvalidOperationException>(
            () => ((ILoadOrderMirror)mod.Mirror).ReingestPluginFromSource(mod.Plugin));
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

    [Fact]
    public async Task AnUnreadableSourceTree_AtReindex_KeepsTheSourceDerivedRows_AndSaysSoInTheFailures()
    {
        using var mod = TrackedModFixture.Tracked();

        var edited = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(mod.Plugin, mod.Npc.ToString(), "height_max", JsonDocument.Parse("0.75").RootElement);
        Assert.True(edited.Applied, edited.Message);

        File.WriteAllText(
            Path.Combine(mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "RecordData.json"),
            "{ this is not json");

        await Assert.ThrowsAnyAsync<Exception>(() => ((ILoadOrderMirror)mod.Mirror).ReindexPlugin(mod.Plugin));

        // The binary was never consulted: it holds the fixture's untouched height_max, and what
        // still answers is the edited 0.75 the source-derived rows already carried.
        var document = mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin)!;
        Assert.Equal(0.75f, Assert.IsType<float>(document.Fields.Single(f => f.Metadata.Name == "height_max").Value));

        var failure = Assert.Single(mod.Mirror.Status.Failures);
        Assert.Equal(TrackedModFixture.PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

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

        // Head is HEAD: the old name, served from the blob at the record's former path. Without the pairing
        // this is null, the new path marking the record working-tree-only while the old path seeds it as
        // committed-only.
        var head = reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal(TrackedModFixture.NpcEditorId, head!.EditorId);
    }

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
