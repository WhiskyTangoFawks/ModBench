using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
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

    private OpenedIndex LaunchedFreshOverTheSameTrackedTreeAndToldNothing() => Indexes.Reconciled(_fixture.GameDirectory, _fixture.Plugins);

    private string NpcSourceFile(OpenedIndex index) =>
        _entry.SourceFileOf(index.DocumentOf(_npc, Plugin));

    private bool ReadFromItsBinaryInPlaceOfItsSource(OpenedIndex index) =>
        index.PluginRowOf(Plugin) is { IsTracked: true, PluginSourceUnreadable: not null };

    private IEnumerable<string> SourceFilesTheReadStoppedAt(OpenedIndex index) =>
        (index.Queries.GetProblems().Value() ?? throw new InvalidOperationException("Expected the index to be ready."))
            .Single(p => PluginAddress.Comparer.Equals(p.Plugin, Plugin)).Problems.Select(p => p.SourceRelativePath);

    private string RootDocument => Path.Combine(ModFolder, PluginSourceRoot.HeaderDocument(PluginName));

    [Fact]
    public void AnExternalEditToASourceFile_IsAtEffectiveAfterReload_WithNoPointRead()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("ExternallyRenamed", reloaded.DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void ADocumentSortedByHandIntoAFolderBelowItsGroup_IsAtEffectiveAfterReload()
    {
        const string editOnlyAReadOfTheTreeCanAnswerBecauseTheBinaryHoldsNoSuchName = "SortedByHandNpc";
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
        {
            var document = NpcSourceFile(live);
            var sorted = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "SortedByHand"));
            File.WriteAllText(
                Path.Combine(sorted.FullName, Path.GetFileName(document)),
                File.ReadAllText(document).Replace(NpcEditorId, editOnlyAReadOfTheTreeCanAnswerBecauseTheBinaryHoldsNoSuchName, StringComparison.Ordinal));
            File.Delete(document);
        }

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal(editOnlyAReadOfTheTreeCanAnswerBecauseTheBinaryHoldsNoSuchName, reloaded.DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void AWorkingTreeDeletedRecord_IsAbsentAtEffectiveAfterReload()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing()) File.Delete(NpcSourceFile(live));

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Null(reloaded.CopyIn(_npc, Plugin));
        var siblingProvingTheLoadReallyIndexedThePlugin = reloaded.CopyIn(_otherNpc, Plugin);
        Assert.NotNull(siblingProvingTheLoadReallyIndexedThePlugin);
    }

    [Fact]
    public void AnUncommittedEdit_IsServedFromTheWorkingTree()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("ExternallyRenamed", reloaded.DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void AnUncommittedHeaderEdit_IsServedFromTheWorkingTree()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

        var editedThroughTheWholeModDoorBecauseItsReaderIsNotAGenericJsonParser = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        editedThroughTheWholeModDoorBecauseItsReaderIsNotAGenericJsonParser.ModHeader.Author = "RenamedByHand";
        File.WriteAllBytes(RootDocument, HeaderDocument.Write(editedThroughTheWholeModDoorBecauseItsReaderIsNotAGenericJsonParser));

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Contains("RenamedByHand", reloaded.BodyOf(headerFormKey, Plugin), StringComparison.Ordinal);
    }

    [Fact]
    public void AnEditCommittedOutsideModbench_IsNotPermanentlyDirty()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.DocumentOf(_npc, Plugin), NpcEditorId, "CommittedRename");
        _entry.Git("add", "-A");
        _entry.Git("commit", "-q", "-m", "external rename");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("CommittedRename", reloaded.DocumentOf(_npc, Plugin).EditorId);
        Assert.Equal(WorkingTreeState.None, reloaded.RowOf(_npc, Plugin)?.WorkingTreeState);
    }

    [Fact]
    public void ReconcilingOneEditedRecord_LeavesItsUntouchedSiblingClean()
    {
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing())
            _entry.HandEdit(live.DocumentOf(_npc, Plugin), NpcEditorId, "ExternallyRenamed");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        var byFormKey = reloaded.ListedIn(Plugin).ToDictionary(r => r.FormKey, StringComparer.Ordinal);

        Assert.Equal(WorkingTreeState.Modified, byFormKey[_npc].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[_otherNpc].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[_race].WorkingTreeState);
    }

    [Fact]
    public async Task ABinaryChangeOnATrackedPlugin_ReDerivesFromItsSourceTree_UnderALiveLoadOrder()
    {
        using var index = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        var before = index.DocumentOf(_npc, Plugin);
        Assert.Equal(NpcEditorId, before.EditorId);

        _entry.HandEdit(before, NpcEditorId, "ExternallyRenamed");

        PluginBinaries.Touch(_entry.Path);
        index.NextSnapshot();

        Assert.Equal("ExternallyRenamed", index.DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void AnUnreadableSourceTree_ReadsTheBinaryInItsPlace_MarkedAsSuch()
    {
        const string halfWrittenRootHeaderTheWholeModDoorReadsFirst = "{ this is not json";
        File.WriteAllText(RootDocument, halfWrittenRootHeaderTheWholeModDoorReadsFirst);

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.NotNull(reloaded.CopyIn(_npc, Plugin));
        Assert.True(ReadFromItsBinaryInPlaceOfItsSource(reloaded));
        Assert.Empty(reloaded.Status.Failures);
    }

    [Fact]
    public void AnUnreadableSourceDocument_AtValidation_ReadsTheBinaryInPlaceOfTheSourceDerivedRows()
    {
        using var index = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();
        var document = index.DocumentOf(_npc, Plugin);
        index.Edit(_entry, document, index.BodyOf(_npc, Plugin).Replace("\"HeightMax\": 0.5", "\"HeightMax\": 0.75", StringComparison.Ordinal));
        const float editedHeightMaxTheBinaryNeverHeldSoOnlySourceDerivedRowsCanAnswerIt = 0.75f;
        Assert.Equal(editedHeightMaxTheBinaryNeverHeldSoOnlySourceDerivedRowsCanAnswerIt, HeightMaxOf(index.DocumentOf(_npc, Plugin)));

        File.WriteAllText(RootDocument, "{ this is not json");

        index.NextSnapshotUntil(
            () => ReadFromItsBinaryInPlaceOfItsSource(index), "the binary read in the tree's place");

        Assert.Equal(BaselineHeightMax, HeightMaxOf(index.DocumentOf(_npc, Plugin)));
        Assert.Empty(index.Status.Failures);
    }

    private static float HeightMaxOf(RecordDetail document) =>
        Assert.IsType<JsonElement>(document.Fields.Single(f => f.Metadata.Name == "HeightMax").Value).GetSingle();

    [Fact]
    public void ADirtyFileThatDeclaresNoFormKey_DegradesToTheBinary_NamingTheFile()
    {
        string document;
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing()) document = NpcSourceFile(live);
        File.WriteAllText(document, """{"EditorID": "HalfWritten"}""");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.True(ReadFromItsBinaryInPlaceOfItsSource(reloaded));
        Assert.Equal(Path.GetRelativePath(ModFolder, document), Assert.Single(SourceFilesTheReadStoppedAt(reloaded)));
    }

    [Fact]
    public void ABackupCopyDeclaringTheSameRecord_DegradesToTheBinary_AndNamesBothDocuments()
    {
        string document;
        using (var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing()) document = NpcSourceFile(live);
        var backup = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "Backup")).FullName, Path.GetFileName(document));
        File.WriteAllText(backup, File.ReadAllText(document).Replace(NpcEditorId, "BackupNpc", StringComparison.Ordinal));

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal(NpcEditorId, reloaded.DocumentOf(_npc, Plugin).EditorId);
        Assert.Equivalent(
            new[] { Path.GetRelativePath(ModFolder, document), Path.GetRelativePath(ModFolder, backup) },
            SourceFilesTheReadStoppedAt(reloaded), strict: true);
    }

    [Fact]
    public void APluginWhoseBinaryCannotBeOpened_TakesARefreshOfItsSourceWithoutThrowing()
    {
        File.WriteAllText(_entry.Path, "this is not a plugin");
        var partnerPath = Path.Combine(_fixture.GameDirectory, "Partner.esp");
        PluginBinaries.Rewrite(partnerPath, mod => mod.Npcs.AddNew("PartnerNpc"));
        using var index = Indexes.Reconciled(
            _fixture.GameDirectory,
            [.. _fixture.Plugins, new LoadOrderEntry("Partner.esp", partnerPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true)]);
        Assert.Contains(index.Status.Failures, f => f.Name == PluginName);
        PluginBinaries.Touch(partnerPath);

        index.NextSnapshot();

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Contains(index.Status.Failures, f => f.Name == PluginName);
    }

    [Fact]
    public void AnEditorIdRename_ReadsAsOneDirtyRecordAfterReload_NotACreateAndADelete()
    {
        RenameTheNpc("RenamedAcrossReload");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Equal("RenamedAcrossReload", reloaded.DocumentOf(_npc, Plugin).EditorId);
    }

    [Fact]
    public void AnEditorIdRename_LeavesExactlyOneEntry()
    {
        RenameTheNpc("RenamedOnce");

        using var reloaded = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();

        Assert.Single(reloaded.StackOf(_npc));
    }

    private void RenameTheNpc(string newEditorId)
    {
        using var live = LaunchedFreshOverTheSameTrackedTreeAndToldNothing();
        var document = live.DocumentOf(_npc, Plugin);
        live.Rename(
            _entry, document, newEditorId,
            live.BodyOf(_npc, Plugin).Replace($"\"{NpcEditorId}\"", $"\"{newEditorId}\"", StringComparison.Ordinal));
    }
}
