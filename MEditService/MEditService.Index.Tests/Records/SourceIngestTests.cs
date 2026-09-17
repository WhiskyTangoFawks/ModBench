using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>A tracked copy's truth is its tree: what the Index answers after an ingest is what the
/// working tree holds, what HEAD holds, and what it says when the tree cannot be read.</summary>
public sealed class SourceIngestTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string KeywordEditorId = "FixtureKeyword";
    private const float BaselineHeightMax = 0.5f;

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly string _npc;
    private readonly string _otherNpc;
    private readonly string _race;
    private readonly string _keyword;

    public SourceIngestTests()
    {
        FormKey npc = default, otherNpc = default, race = default, keyword = default;
        _fixture = new PluginFixtureBuilder("source-ingest")
            .WithPlugin(PluginName, mod =>
            {
                var theRace = mod.Races.AddNew("FixtureRace");
                keyword = mod.Keywords.AddNew(KeywordEditorId).FormKey;
                var theNpc = mod.Npcs.AddNew(NpcEditorId);
                theNpc.Race.SetTo(theRace);
                theNpc.HeightMax = BaselineHeightMax;
                otherNpc = mod.Npcs.AddNew("UntouchedNpc").FormKey;
                (npc, race) = (theNpc.FormKey, theRace.FormKey);
            }, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _entry = _fixture.Plugins.Single();
        (_npc, _otherNpc, _race, _keyword) =
            (npc.ToString(), otherNpc.ToString(), race.ToString(), keyword.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private PluginCopyKey Plugin => _entry.KeyOf();

    private string ModFolder => _entry.ModFolderOf();

    // A fresh Index over the same tracked tree: the launch that has to read whatever the tree now
    // holds, having been told nothing.
    private IndexProjector Opened() => Indexes.Reconciled(_fixture.GameDirectory, _fixture.Plugins);

    private string NpcSourceFile(IndexProjector index) =>
        _entry.SourceFileOf(index.RequireReads().DocumentOf(_npc, Plugin));

    private string RootDocument => Path.Combine(ModFolder, SourceRepository.RootFor(PluginName), "RecordData.json");

    // ---- The working tree is Effective ----

    [Fact]
    public void AnExternalEditToASourceFile_IsAtEffectiveAfterReload_WithNoPointRead()
    {
        // A hand edit outside Modbench — the user's own editor, an agent's script, a git checkout.
        // Nothing tells the backend it happened; the next reconcile is simply expected to read it.
        using (var live = Opened())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = Opened();

        Assert.Equal("ExternallyRenamed", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
    }

    // ---- The reappearing-record gap, resolved by construction ----

    [Fact]
    public void AWorkingTreeDeletedRecord_IsAbsentAtEffectiveAfterReload()
    {
        using (var live = Opened()) File.Delete(NpcSourceFile(live));

        using var reloaded = Opened();

        Assert.Null(reloaded.RequireReads().GetDocument(_npc, Plugin));
        // Positive control: the load really happened and really indexed this plugin, or "absent"
        // would be true of a load that did nothing at all.
        Assert.NotNull(reloaded.RequireReads().GetDocument(_otherNpc, Plugin));
    }

    [Fact]
    public void AnUncommittedEdit_LeavesHeadOnTheCommittedBytes_ServedAsGitShowServesThem()
    {
        string relativePath;
        using (var live = Opened())
        {
            var document = live.RequireReads().DocumentOf(_npc, Plugin);
            relativePath = Path.GetRelativePath(ModFolder, _entry.SourceFileOf(document));
            _entry.HandEdit(document, NpcEditorId, "ExternallyRenamed");
        }

        using var reloaded = Opened();

        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal(NpcEditorId, head.EditorId);
        // The Head row is HEAD's own bytes, not a reconstruction: same text `git show` serves.
        Assert.Equal(_entry.Git("show", $"HEAD:{relativePath.Replace('\\', '/')}"), head.Body);
    }

    // ---- HEAD is Head, the working tree is Effective, and they diverge ----

    [Fact]
    public void AnUncommittedEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        using (var live = Opened())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = Opened();

        Assert.Equal("ExternallyRenamed", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal(NpcEditorId, head.EditorId);
    }

    [Fact]
    public void AnUncommittedHeaderEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

        // Rebuilt through the same door the production path uses, never a hand-spliced JSON string: the
        // whole-mod door's reader is not a generic JSON parser, so a raw text edit cannot promise a
        // byte-for-byte round trip.
        var edited = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        edited.ModHeader.Author = "RenamedByHand";
        File.WriteAllBytes(RootDocument, HeaderDocument.Write(edited));

        using var reloaded = Opened();

        var effective = reloaded.RequireReads().GetDocument(headerFormKey, Plugin);
        var head = reloaded.RequireReads().HeadDocument(headerFormKey, Plugin);

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
        using (var live = Opened())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "CommittedRename");
        _entry.Git("add", "-A");
        _entry.Git("commit", "-q", "-m", "external rename");

        using var reloaded = Opened();

        // HEAD moved with the working tree, so the record is clean against its *new* baseline —
        // not dirty against a baseline no ref holds any more.
        Assert.Equal("CommittedRename", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal("CommittedRename", head.EditorId);
    }

    [Fact]
    public void ReconcilingOneEditedRecord_LeavesItsUntouchedSiblingClean()
    {
        using (var live = Opened())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = Opened();

        var byFormKey = reloaded.RequireReads().Search(new RecordQuery(Plugin: PluginName, Limit: 100))
            .Items.ToDictionary(r => r.FormKey, StringComparer.Ordinal);

        Assert.Equal(WorkingTreeState.Modified, byFormKey[_npc].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[_otherNpc].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[_race].WorkingTreeState);
    }

    // ---- Re-indexing a tracked copy reads its tree, never its binary ----

    [Fact]
    public async Task ReindexPlugin_OnATrackedCopy_ReDerivesFromItsSourceTree_UnderALiveLoadOrder()
    {
        using var index = Opened();

        var before = index.Projected().DocumentOf(_npc, Plugin);
        Assert.Equal(NpcEditorId, before.EditorId);

        _entry.HandEdit(before, NpcEditorId, "ExternallyRenamed");

        await index.ReindexPlugin(Plugin);

        Assert.Equal("ExternallyRenamed", index.Projected().DocumentOf(_npc, Plugin).EditorId);
    }

    // ---- A source tree that cannot be read degrades to the binary, visibly ----

    [Fact]
    public void AnUnreadableSourceTree_FallsBackToTheBinary_AndSaysSoInTheFailures()
    {
        // Never-assume-exclusive-ownership: MO2, a git operation, or the user can leave this tree
        // half-written at any moment. The root header is what the whole-mod door reads first.
        File.WriteAllText(RootDocument, "{ this is not json");

        using var reloaded = Opened();

        // Degraded, not dropped — the plugin's records are still queryable from the binary.
        Assert.NotNull(reloaded.RequireReads().GetDocument(_npc, Plugin));

        // ...and the degradation is *visible*, which is the whole mitigation: a user reading
        // pre-Track binary content while believing they are reading their tracked source is the hazard.
        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AnUnreadableSourceTree_AtReindex_KeepsTheSourceDerivedRows_AndSaysSoInTheFailures()
    {
        using var index = Opened();
        var document = index.RequireReads().DocumentOf(_npc, Plugin);
        index.Edit(_entry, document, document.BodyOf().Replace("\"HeightMax\": 0.5", "\"HeightMax\": 0.75", StringComparison.Ordinal));
        Assert.Equal(0.75f, HeightMaxOf(index.Projected().DocumentOf(_npc, Plugin)));

        File.WriteAllText(RootDocument, "{ this is not json");

        await Assert.ThrowsAnyAsync<Exception>(() => index.ReindexPlugin(Plugin));

        // The binary was never consulted: it holds the fixture's untouched height_max, and what
        // still answers is the edited 0.75 the source-derived rows already carried.
        Assert.Equal(0.75f, HeightMaxOf(index.Projected().DocumentOf(_npc, Plugin)));

        var failure = Assert.Single(index.Status.Failures);
        Assert.Equal(PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    private static float HeightMaxOf(RecordDocument document) =>
        Assert.IsType<JsonElement>(document.Fields.Single(f => f.Metadata.Name == "HeightMax").Value).GetSingle();

    // Never-assume-exclusive-ownership: a file another tool leaves half-written declares no FormKey,
    // and a record going missing from the read model without a word is the hazard.
    [Fact]
    public void ADirtyFileThatDeclaresNoFormKey_DegradesToTheBinary_AndSaysSoInTheFailures()
    {
        using (var live = Opened())
            File.WriteAllText(NpcSourceFile(live), """{"EditorID": "HalfWritten"}""");

        using var reloaded = Opened();

        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void APartialReconcileThenBinaryFallback_LeavesExactlyOneEntry_NotTwo()
    {
        var sourceRoot = Path.Combine(ModFolder, SourceRepository.RootFor(PluginName));
        string keywordFile;
        using (var live = Opened())
            keywordFile = _entry.SourceFileOf(live.RequireReads().DocumentOf(_keyword, Plugin));

        // A committed file the per-record codec cannot read back. "Npcs" sorts after "Keywords" and git
        // orders porcelain output by path, so the good deletion below is processed first.
        var poison = Path.Combine(sourceRoot, "Npcs", "zzbroken.json");
        File.WriteAllText(poison, "{ not a record");
        _entry.Git("add", "-A");
        _entry.Git("commit", "-q", "-m", "commit an unreadable record");

        // Two working-tree deletions. The first re-seeds Head and commits; the second throws when its
        // HEAD blob is parsed, aborting the ingest partway through the dirty set.
        File.Delete(keywordFile);
        File.Delete(poison);

        using var reloaded = Opened();

        // Precondition: the ingest really did fail partway and fall back, or this proves nothing.
        Assert.NotEmpty(reloaded.Status.Failures);

        var stack = reloaded.RequireReads().GetOverrideStack(_keyword);
        Assert.NotNull(stack);
        Assert.Single(stack.Entries);
    }

    // ---- A renamed source unit is one dirty record, not two half-records ----

    [Fact]
    public void AnEditorIdRename_ReadsAsOneDirtyRecordAfterReload_NotACreateAndADelete()
    {
        RenameTheNpc("RenamedAcrossReload");

        using var reloaded = Opened();

        // Effective is the working tree: the new name.
        Assert.Equal("RenamedAcrossReload", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);

        // Head is HEAD: the old name, served from the blob at the record's former path. Without the pairing
        // this is null, the new path marking the record working-tree-only while the old path seeds it as
        // committed-only.
        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal(NpcEditorId, head.EditorId);
    }

    [Fact]
    public void AnEditorIdRename_LeavesExactlyOneEntry_WithTheOldNameCommitted()
    {
        RenameTheNpc("RenamedOnce");

        using var reloaded = Opened();

        var stack = reloaded.RequireReads().GetOverrideStack(_npc);
        Assert.NotNull(stack);
        var entry = Assert.Single(stack.Entries);
        Assert.Equal(NpcEditorId, entry.Head.EditorId);
    }

    private void RenameTheNpc(string newEditorId)
    {
        using var live = Opened();
        var document = live.RequireReads().DocumentOf(_npc, Plugin);
        live.Rename(
            _entry, document, newEditorId,
            document.BodyOf().Replace($"\"{NpcEditorId}\"", $"\"{newEditorId}\"", StringComparison.Ordinal));
    }
}
