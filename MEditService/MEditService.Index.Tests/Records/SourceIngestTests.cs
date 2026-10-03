using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

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

    private PluginAddress Plugin => _entry.KeyOf();

    private string ModFolder => _entry.ModFolderOf();

    private Indexer LaunchedFreshOverTheSameTrackedTreeAndToldNothing() => Indexes.Reconciled(_fixture.GameDirectory, _fixture.Plugins);

    private string NpcSourceFile(Indexer index) =>
        _entry.SourceFileOf(index.RequireReads().DocumentOf(_npc, Plugin));

    private string RootDocument => Path.Combine(ModFolder, SourceRepository.RootFor(PluginName), "RecordData.json");

    [Fact]
    public void AnExternalEditToASourceFile_IsAtEffectiveAfterReload_WithNoPointRead()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("ExternallyRenamed", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void ADocumentSortedByHandIntoAFolderBelowItsGroup_IsAtEffectiveAfterReload()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
        {
            var document = NpcSourceFile(live);
            var sorted = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "SortedByHand"));
            File.WriteAllText(
                Path.Combine(sorted.FullName, Path.GetFileName(document)),
                File.ReadAllText(document).Replace(NpcEditorId, "SortedByHandNpc", StringComparison.Ordinal));
            File.Delete(document);
        }

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("SortedByHandNpc", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void AWorkingTreeDeletedRecord_IsAbsentAtEffectiveAfterReload()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing()) File.Delete(NpcSourceFile(live));

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Null(reloaded.RequireReads().GetDocument(_npc, Plugin));
        var siblingProvingTheLoadReallyIndexedThePlugin = reloaded.RequireReads().GetDocument(_otherNpc, Plugin);
        Assert.NotNull(siblingProvingTheLoadReallyIndexedThePlugin);
    }

    [Fact]
    public void AnUncommittedEdit_LeavesHeadOnTheCommittedBytes_ServedAsGitShowServesThem()
    {
        string relativePath;
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
        {
            var document = live.RequireReads().DocumentOf(_npc, Plugin);
            relativePath = Path.GetRelativePath(ModFolder, _entry.SourceFileOf(document));
            _entry.HandEdit(document, NpcEditorId, "ExternallyRenamed");
        }

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal(NpcEditorId, head.EditorId);
        Assert.Equal(_entry.Git("show", $"HEAD:{relativePath.Replace('\\', '/')}"), head.Body);
    }

    [Fact]
    public void AnUncommittedEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("ExternallyRenamed", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal(NpcEditorId, head.EditorId);
    }

    [Fact]
    public void AnUncommittedHeaderEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

        var editedThroughTheWholeModDoorBecauseItsReaderIsNotAGenericJsonParser = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        editedThroughTheWholeModDoorBecauseItsReaderIsNotAGenericJsonParser.ModHeader.Author = "RenamedByHand";
        File.WriteAllBytes(RootDocument, HeaderDocument.Write(editedThroughTheWholeModDoorBecauseItsReaderIsNotAGenericJsonParser));

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

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
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "CommittedRename");
        _entry.Git("add", "-A");
        _entry.Git("commit", "-q", "-m", "external rename");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("CommittedRename", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal("CommittedRename", head.EditorId);
        Assert.False(reloaded.RequireReads().StackEntry(_npc, Plugin).Require().HasWorkingTreeChange);
    }

    [Fact]
    public void ReconcilingOneEditedRecord_LeavesItsUntouchedSiblingClean()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.RequireReads().DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        var byFormKey = reloaded.RequireReads().Search(new RecordQuery(Plugin: PluginName, Limit: 100))
            .Items.ToDictionary(r => r.FormKey, StringComparer.Ordinal);

        Assert.Equal(WorkingTreeState.Modified, byFormKey[_npc].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[_otherNpc].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[_race].WorkingTreeState);
    }

    [Fact]
    public async Task ABinaryChangeOnATrackedPlugin_ReDerivesFromItsSourceTree_UnderALiveLoadOrder()
    {
        using var index = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        var before = index.Projected().DocumentOf(_npc, Plugin);
        Assert.Equal(NpcEditorId, before.EditorId);

        _entry.HandEdit(before, NpcEditorId, "ExternallyRenamed");

        PluginBinaries.Touch(_entry.Path);
        Assert.True(index.Revalidate());

        Assert.Equal("ExternallyRenamed", index.Projected().DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void AnUnreadableSourceTree_FallsBackToTheBinary_AndSaysSoInTheFailures()
    {
        const string halfWrittenRootHeaderTheWholeModDoorReadsFirst = "{ this is not json";
        File.WriteAllText(RootDocument, halfWrittenRootHeaderTheWholeModDoorReadsFirst);

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.NotNull(reloaded.RequireReads().GetDocument(_npc, Plugin));

        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AnUnreadableSourceDocument_AtValidation_KeepsTheSourceDerivedRows_AndSaysSoInTheFailures()
    {
        using var index = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();
        var document = index.RequireReads().DocumentOf(_npc, Plugin);
        index.Edit(_entry, document, document.BodyOf().Replace("\"HeightMax\": 0.5", "\"HeightMax\": 0.75", StringComparison.Ordinal));
        const float editedHeightMaxTheBinaryNeverHeldSoOnlySourceDerivedRowsCanAnswerIt = 0.75f;
        Assert.Equal(editedHeightMaxTheBinaryNeverHeldSoOnlySourceDerivedRowsCanAnswerIt, HeightMaxOf(index.Projected().DocumentOf(_npc, Plugin)));

        File.WriteAllText(RootDocument, "{ this is not json");

        index.NextSnapshot();

        Assert.Equal(editedHeightMaxTheBinaryNeverHeldSoOnlySourceDerivedRowsCanAnswerIt, HeightMaxOf(index.Projected().DocumentOf(_npc, Plugin)));

        var failure = Assert.Single(index.Status.Failures);
        Assert.Equal(PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    private static float HeightMaxOf(RecordDocument document) =>
        Assert.IsType<JsonElement>(document.Fields.Single(f => f.Metadata.Name == "HeightMax").Value).GetSingle();

    [Fact]
    public void ADirtyFileThatDeclaresNoFormKey_DegradesToTheBinary_AndSaysSoInTheFailures()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            File.WriteAllText(NpcSourceFile(live), """{"EditorID": "HalfWritten"}""");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ABackupCopyDeclaringTheSameRecord_DegradesToTheBinary_AndNamesBothDocuments()
    {
        string document;
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing()) document = NpcSourceFile(live);
        var backup = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "Backup")).FullName, Path.GetFileName(document));
        File.WriteAllText(backup, File.ReadAllText(document).Replace(NpcEditorId, "BackupNpc", StringComparison.Ordinal));

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal(NpcEditorId, reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);
        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Contains(Path.GetRelativePath(ModFolder, document), failure.Reason, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(ModFolder, backup), failure.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void APluginWhoseBinaryCannotBeOpened_TakesARefreshOfItsSourceWithoutThrowing()
    {
        File.WriteAllText(_entry.Path, "this is not a plugin");
        using var index = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();
        Assert.Contains(index.Status.Failures, f => f.Name == PluginName);

        index.NextSnapshot();
    }

    [Fact]
    public void APartialReconcileThenBinaryFallback_LeavesExactlyOneEntry_NotTwo()
    {
        var sourceRoot = Path.Combine(ModFolder, SourceRepository.RootFor(PluginName));
        string keywordFile;
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            keywordFile = _entry.SourceFileOf(live.RequireReads().DocumentOf(_keyword, Plugin));

        var committedFileTheCodecCannotReadBackUnderNpcsWhichSortsAfterKeywordsSoGitPorcelainProcessesTheGoodDeletionFirst =
            Path.Combine(sourceRoot, "Npcs", "zzbroken.json");
        File.WriteAllText(committedFileTheCodecCannotReadBackUnderNpcsWhichSortsAfterKeywordsSoGitPorcelainProcessesTheGoodDeletionFirst, "{ not a record");
        _entry.Git("add", "-A");
        _entry.Git("commit", "-q", "-m", "commit an unreadable record");

        File.Delete(keywordFile);
        File.Delete(committedFileTheCodecCannotReadBackUnderNpcsWhichSortsAfterKeywordsSoGitPorcelainProcessesTheGoodDeletionFirst);

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.NotEmpty(reloaded.Status.Failures);

        var stack = reloaded.RequireReads().GetOverrideStack(_keyword);
        Assert.NotNull(stack);
        Assert.Single(stack.Entries);
    }

    [Fact]
    public void AnEditorIdRename_ReadsAsOneDirtyRecordAfterReload_NotACreateAndADelete()
    {
        RenameTheNpc("RenamedAcrossReload");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("RenamedAcrossReload", reloaded.RequireReads().DocumentOf(_npc, Plugin).EditorId);

        var head = reloaded.RequireReads().HeadDocument(_npc, Plugin);
        Assert.NotNull(head);
        Assert.Equal(NpcEditorId, head.EditorId);
    }

    [Fact]
    public void AnEditorIdRename_LeavesExactlyOneEntry_WithTheOldNameCommitted()
    {
        RenameTheNpc("RenamedOnce");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        var stack = reloaded.RequireReads().GetOverrideStack(_npc);
        Assert.NotNull(stack);
        var entry = Assert.Single(stack.Entries);
        Assert.Equal(NpcEditorId, entry.Head.EditorId);
    }

    private void RenameTheNpc(string newEditorId)
    {
        using var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();
        var document = live.RequireReads().DocumentOf(_npc, Plugin);
        live.Rename(
            _entry, document, newEditorId,
            document.BodyOf().Replace($"\"{NpcEditorId}\"", $"\"{newEditorId}\"", StringComparison.Ordinal));
    }
}
