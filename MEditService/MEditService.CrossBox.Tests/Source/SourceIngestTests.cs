using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Queries;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>Every test reads the raw <c>IRecordIndex</c>, never <c>RecordQueryService</c>: its read-time
/// self-heal would make a binary-seeded ingest look source-seeded.</summary>
public sealed class SourceIngestTests
{
    private static IndexProjector Reload(LoadOrderHolder holder, IndexedModFixture mod)
    {
        var index = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        index.Reconcile(holder,
            mod.GameDirectory,
            [new LoadOrderEntry(IndexedModFixture.PluginName, Path.Combine(mod.ModFolder, IndexedModFixture.PluginName), IndexedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        return index;
    }

    private static IRecordIndex Store(IndexProjector index) =>
        index.Store ?? throw new InvalidOperationException("Expected Reconcile to have populated the index store.");

    // ---- The working tree is Effective ----

    [Fact]
    public void AnExternalEditToASourceFile_IsAtEffectiveAfterReload_WithNoPointRead()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        // A hand edit outside Modbench — the user's own editor, an agent's script, a git checkout.
        // Nothing tells the backend it happened; the next reconcile is simply expected to read it.
        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            IndexedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(holder, mod);

        var record = Store(reloaded).At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(record);
        Assert.Equal("ExternallyRenamed", record.EditorId);
    }

    // ---- The reappearing-record gap, resolved by construction ----

    [Fact]
    public void AWorkingTreeDeletedRecord_IsAbsentAtEffectiveAfterReload()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        File.Delete(mod.NpcSourceFile);

        using var reloaded = Reload(holder, mod);

        Assert.Null(Store(reloaded).At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin));
        // Positive control: the load really happened and really indexed this plugin, or "absent"
        // would be true of a load that did nothing at all.
        Assert.NotNull(Store(reloaded).At(RecordRef.Effective).GetDocument(mod.OtherNpc.ToString(), mod.Plugin));
    }

    [Fact]
    public void AWorkingTreeDeletedRecord_StillAnswersAtHead()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        File.Delete(mod.NpcSourceFile);

        using var reloaded = Reload(holder, mod);

        var head = Store(reloaded).At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal(IndexedModFixture.NpcEditorId, head.EditorId);
        // The Head row is HEAD's own bytes, not a reconstruction: same text `git show` serves.
        Assert.Equal(mod.GitShowHead(mod.RelativeSourcePath(
            mod.Npc, "npc_", IndexedModFixture.NpcEditorId)), head.Body);
    }

    // ---- HEAD is Head, the working tree is Effective, and they diverge ----

    [Fact]
    public void AnUncommittedEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            IndexedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(holder, mod);

        var effective = Store(reloaded).At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("ExternallyRenamed", effective.EditorId);
        var head = Store(reloaded).At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal(IndexedModFixture.NpcEditorId, head.EditorId);
    }

    [Fact]
    public void AnUncommittedHeaderEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(IndexedModFixture.PluginName));
        var headerPath = Path.Combine(mod.ModFolder, "source", IndexedModFixture.PluginName, "RecordData.json");

        // Rebuilt through the same door the production path uses, never a hand-spliced JSON string: the
        // whole-mod door's reader is not a generic JSON parser, so a raw text edit cannot promise a
        // byte-for-byte round trip.
        var edited = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        edited.ModHeader.Author = "RenamedByHand";
        File.WriteAllBytes(headerPath, HeaderDocument.Write(edited));

        using var reloaded = Reload(holder, mod);

        var effective = Store(reloaded).At(RecordRef.Effective).GetDocument(headerFormKey, mod.Plugin);
        var head = Store(reloaded).At(RecordRef.Head).GetDocument(headerFormKey, mod.Plugin);

        Assert.NotNull(effective);
        Assert.NotNull(head);
        Assert.NotNull(effective.Body);
        Assert.NotNull(head.Body);
        Assert.Contains("RenamedByHand", effective.Body, StringComparison.Ordinal);
        Assert.DoesNotContain("RenamedByHand", head.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEditCommittedOutsideModbench_LeavesBothRefsOnTheNewBytes_NotPermanentlyDirty()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            IndexedModFixture.NpcEditorId, "CommittedRename", StringComparison.Ordinal));
        var gitDir = Path.Combine(mod.ModFolder, ".git");
        GitProbe.Run(gitDir, mod.ModFolder, "add", "-A");
        GitProbe.Run(gitDir, mod.ModFolder, "commit", "-q", "-m", "external rename");

        using var reloaded = Reload(holder, mod);

        // HEAD moved with the working tree, so the record is clean against its *new* baseline —
        // not dirty against a baseline no ref holds any more.
        var effective = Store(reloaded).At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("CommittedRename", effective.EditorId);
        var head = Store(reloaded).At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal("CommittedRename", head.EditorId);
    }

    [Fact]
    public void ReconcilingOneEditedRecord_LeavesItsUntouchedSiblingClean()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            IndexedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(holder, mod);

        var byFormKey = Store(reloaded)
            .At(RecordRef.Effective).Search(new RecordQuery { Plugin = IndexedModFixture.PluginName, Limit = 100 })
            .Items.ToDictionary(r => r.FormKey, StringComparer.Ordinal);

        Assert.Equal(WorkingTreeState.Modified, byFormKey[mod.Npc.ToString()].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[mod.OtherNpc.ToString()].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[mod.Race.ToString()].WorkingTreeState);
    }

    // ---- Re-indexing a tracked copy reads its tree, never its binary ----

    [Fact]
    public async Task ReindexPlugin_OnATrackedCopy_ReDerivesFromItsSourceTree_UnderALiveLoadOrder()
    {
        using var mod = IndexedModFixture.Tracked();

        var before = mod.Index.Projected().GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(before);
        Assert.Equal(IndexedModFixture.NpcEditorId, before.EditorId);

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            IndexedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        await mod.Index.ReindexPlugin(mod.Plugin);

        var after = mod.Index.Projected().GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(after);
        Assert.Equal("ExternallyRenamed", after.EditorId);
    }

    // ---- A source tree that cannot be read degrades to the binary, visibly ----

    [Fact]
    public void AnUnreadableSourceTree_FallsBackToTheBinary_AndSaysSoInTheFailures()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        // Never-assume-exclusive-ownership: MO2, a git operation, or the user can leave this tree
        // half-written at any moment. The root header is what the whole-mod door reads first.
        File.WriteAllText(
            Path.Combine(mod.ModFolder, SourceRepository.RootFor(IndexedModFixture.PluginName), "RecordData.json"),
            "{ this is not json");

        using var reloaded = Reload(holder, mod);

        // Degraded, not dropped — the plugin's records are still queryable from the binary.
        Assert.NotNull(Store(reloaded).At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin));

        // ...and the degradation is *visible*, which is the whole mitigation: a user reading
        // pre-Track binary content while believing they are reading their tracked source is the hazard.
        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(IndexedModFixture.PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AnUnreadableSourceTree_AtReindex_KeepsTheSourceDerivedRows_AndSaysSoInTheFailures()
    {
        using var mod = IndexedModFixture.Tracked();

        var edited = ProjectingEditService.Over(mod.Index, mod.Holder)
            .Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        Assert.True(edited.Applied, edited.Message);

        File.WriteAllText(
            Path.Combine(mod.ModFolder, SourceRepository.RootFor(IndexedModFixture.PluginName), "RecordData.json"),
            "{ this is not json");

        await Assert.ThrowsAnyAsync<Exception>(() => mod.Index.ReindexPlugin(mod.Plugin));

        // The binary was never consulted: it holds the fixture's untouched height_max, and what
        // still answers is the edited 0.75 the source-derived rows already carried.
        var document = mod.Index.Projected().GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(document);
        Assert.Equal(0.75f, Assert.IsType<JsonElement>(document.Fields.Single(f => f.Metadata.Name == "HeightMax").Value).GetSingle());

        var failure = Assert.Single(mod.Index.Status.Failures);
        Assert.Equal(IndexedModFixture.PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    // Never-assume-exclusive-ownership: a file another tool leaves half-written declares no FormKey,
    // and a record going missing from the read model without a word is the hazard.
    [Fact]
    public void ADirtyFileThatDeclaresNoFormKey_DegradesToTheBinary_AndSaysSoInTheFailures()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        File.WriteAllText(mod.NpcSourceFile, """{"EditorID": "HalfWritten"}""");

        using var reloaded = Reload(holder, mod);

        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(IndexedModFixture.PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void APartialReconcileThenBinaryFallback_LeavesExactlyOneRowAtHead_NotTwo()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();
        var gitDir = Path.Combine(mod.ModFolder, ".git");
        var sourceRoot = Path.Combine(mod.ModFolder, SourceRepository.RootFor(IndexedModFixture.PluginName));

        // A committed file the per-record codec cannot read back. "Npcs" sorts after "Keywords" and git
        // orders porcelain output by path, so the good deletion below is processed first.
        var poison = Path.Combine(sourceRoot, "Npcs", "zzbroken.json");
        File.WriteAllText(poison, "{ not a record");
        GitProbe.Run(gitDir, mod.ModFolder, "add", "-A");
        GitProbe.Run(gitDir, mod.ModFolder, "commit", "-q", "-m", "commit an unreadable record");

        // Two working-tree deletions. The first re-seeds Head and commits; the second throws when its
        // HEAD blob is parsed, aborting the ingest partway through the dirty set.
        File.Delete(Path.Combine(mod.ModFolder, mod.RelativeSourcePath(
            mod.Keyword, "kywd", IndexedModFixture.KeywordEditorId)));
        File.Delete(poison);

        using var reloaded = Reload(holder, mod);

        // Precondition: the ingest really did fail partway and fall back, or this proves nothing.
        Assert.NotEmpty(reloaded.Status.Failures);

        var atHead = Store(reloaded).At(RecordRef.Head)
            .Search(new RecordQuery(Plugin: mod.Plugin.Name, Origin: mod.Plugin.Origin, Limit: int.MaxValue))
            .Items.Count(r => string.Equals(r.FormKey, mod.Keyword.ToString(), StringComparison.Ordinal));

        Assert.Equal(1, atHead);
    }

    // ---- A renamed source unit is one dirty record, not two half-records ----

    [Fact]
    public void AnEditorIdRename_ReadsAsOneDirtyRecordAfterReload_NotACreateAndADelete()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        var edit = ProjectingEditService.Over(mod.Index, mod.Holder)
            .Set(mod.Plugin, mod.Npc.ToString(), "EditorID",
                JsonDocument.Parse("\"RenamedAcrossReload\"").RootElement);
        Assert.True(edit.Applied, edit.Message);

        using var reloaded = Reload(holder, mod);

        // Effective is the working tree: the new name.
        var effective = Store(reloaded).At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedAcrossReload", effective.EditorId);

        // Head is HEAD: the old name, served from the blob at the record's former path. Without the pairing
        // this is null, the new path marking the record working-tree-only while the old path seeds it as
        // committed-only.
        var head = Store(reloaded).At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal(IndexedModFixture.NpcEditorId, head.EditorId);
    }

    [Fact]
    public void AnEditorIdRename_LeavesExactlyOneRowAtHead()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();

        ProjectingEditService.Over(mod.Index, mod.Holder)
            .Set(mod.Plugin, mod.Npc.ToString(), "EditorID",
                JsonDocument.Parse("\"RenamedOnce\"").RootElement);

        using var reloaded = Reload(holder, mod);

        var atHead = Store(reloaded).At(RecordRef.Head)
            .Search(new RecordQuery(Plugin: mod.Plugin.Name, Origin: mod.Plugin.Origin, Limit: int.MaxValue))
            .Items.Count(r => string.Equals(r.FormKey, mod.Npc.ToString(), StringComparison.Ordinal));

        Assert.Equal(1, atHead);
    }
}
