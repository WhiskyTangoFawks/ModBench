using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryDirtOfTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string NpcFormKey = "000800:Test.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private const string EditedBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"Edited\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "TestMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private static readonly string NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk =
        Path.Combine("plugin-source", PluginName, "Npcs", $"{NpcEditorId} - 000800_{PluginName}.json");

    private readonly ScratchDirectory _modFolder = new("medit-dirtof-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Tracked(params TreeFile[] extraFiles)
    {
        var files = new[] { new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody)) }.Concat(extraFiles).ToArray();
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits, files);
        return SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void DirtOf_ReportsAnUnstagedEditNeverGitAdded_ToAFileTrackAlreadyCommitted()
    {
        var repository = Tracked();

        File.WriteAllText(Path.Combine(_modFolder, NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk), EditedBody);

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.Equal(NpcBody, only.CommittedText);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_OfAStagedRenameOutOfAFolderNamedLikeTheTree_FindsNothingToReconcile_ForARenamesOldPathRidesABareTokenWithNoStatusCode()
    {
        var rootSegment = SourceRepository.RootFor(PluginName).Split(Path.DirectorySeparatorChar)[0];
        var lookalikeFolderName = "xyz" + rootSegment;
        var oldFolder = Directory.CreateDirectory(Path.Combine(_modFolder, lookalikeFolderName, PluginName)).FullName;
        File.WriteAllText(Path.Combine(oldFolder, "notes.txt"), "notes");
        PluginBaselines.Track(_modFolder, SourcePreset.Everything, [new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
        var repository = SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "mv", $"{lookalikeFolderName}/{PluginName}/notes.txt", "notes.txt");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_AStagedRename_NamesThePathItLeftWithHeadsText()
    {
        var repository = Tracked();
        var renamed = Path.Combine("plugin-source", PluginName, "Npcs", $"Renamed - 000800_{PluginName}.json");
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "mv",
            NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk.Replace('\\', '/'), renamed.Replace('\\', '/'));

        var dirt = repository.DirtOf(Plugin);

        Assert.Equal(2, dirt.Documents.Count);
        Assert.Contains(dirt.Documents, d => !d.InWorkingTree && d.CommittedText == NpcBody);
        Assert.Contains(dirt.Documents, d => d.InWorkingTree && d.CommittedText == null);
    }

    [Fact]
    public void DirtOf_AnEditToADocumentSortedBelowItsGroup_NamesItsRecordAsThatGroupsType()
    {
        var sortedPath = Path.Combine("plugin-source", PluginName, "Npcs", "SortedByHand", $"Sorted - 000900_{PluginName}.json");
        var repository = Tracked(new TreeFile(sortedPath, Encoding.UTF8.GetBytes($"{{\"FormKey\":\"000900:{PluginName}\"}}")));

        File.WriteAllText(Path.Combine(_modFolder, sortedPath), $"{{\"FormKey\":\"000900:{PluginName}\",\"EditorID\":\"Edited\"}}");

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal($"000900:{PluginName}", only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_ReportsNothing_ForACleanRepo()
    {
        var repository = Tracked();

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_AWorkingTreeDeletion_NamesTheRecordAsGoneFromTheTree()
    {
        var repository = Tracked();

        File.Delete(Path.Combine(_modFolder, NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk));

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.False(only.InWorkingTree);
        Assert.Equal(NpcBody, only.CommittedText);
    }

    [Fact]
    public void DirtOf_AnUntrackedDocumentNoRefHolds_NamesItWithNoCommittedText_AsAPutLeavesItForPutNeverRunsGitAdd()
    {
        var repository = Tracked();
        var createdPath = Path.Combine("plugin-source", PluginName, "Npcs", $"Created - 000900_{PluginName}.json");
        File.WriteAllText(
            Path.Combine(_modFolder, createdPath), $"{{\"FormKey\":\"000900:{PluginName}\",\"EditorID\":\"Created\"}}");

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal($"000900:{PluginName}", only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.Null(only.CommittedText);
    }

    [Fact]
    public void DirtOf_ForTheHeadersOwnRecordDataJson_NamesItsComputedFormKey_ThoughTheDocumentCarriesNoFormKey()
    {
        var headerPath = Path.Combine("plugin-source", PluginName, "RecordData.json");
        var repository = Tracked(new TreeFile(headerPath, "{\"MasterReferences\": []}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, headerPath), "{\"MasterReferences\": [], \"Changed\": true}");

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName)), only.FormKey);
        Assert.Equal(PluginHeader.RecordType, only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Theory]
    [InlineData("plugin-source/Test.esp/000800.json")]
    [InlineData("plugin-source/Test.esp/NotRecordData.json")]
    public void DirtOf_APathTooShortForAFlatRecordAndNotLiterallyTheHeadersRecordDataJson_DefersToTheStructuralPass_NeverAsARecord(
        string relativePath) => AssertDefersToTheStructuralPass(relativePath);

    [Theory]
    [InlineData("plugin-source/Test.esp/Npcs/000800.txt")]
    [InlineData("plugin-source/Test.esp/Npcs/000800")]
    public void DirtOf_APathMissingTheJsonSuffix_DefersToTheStructuralPass_NeverAsARecord(
        string relativePath) => AssertDefersToTheStructuralPass(relativePath);

    [Theory]
    [InlineData("plugin-source/Test.esp/Npcs/RecordData.json")]
    [InlineData("plugin-source/Test.esp/Cells/GroupRecordData.json")]
    public void DirtOf_AWholeModDoorHeaderOrGroupFileAtTheWrongDepth_DefersToTheStructuralPass_NeverAsARecord(
        string relativePath) => AssertDefersToTheStructuralPass(relativePath);

    [Fact]
    public void DirtOf_APathUnderAFolderTheGamesSchemaHasNoGroupFor_DefersToTheStructuralPass_NeverAsARecord() =>
        AssertDefersToTheStructuralPass("plugin-source/Test.esp/NotARealFolder/000800.json");

    private void AssertDefersToTheStructuralPass(string relativePath)
    {
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);
        var repository = Tracked(new TreeFile(normalized, "{}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, normalized), "{\"changed\":true}");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.True(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_ForAPathUnderAnAmbiguousGroupsFolder_DefersToTheStructuralPass_ForThePathAloneCannotSayWhichConcreteTypeTheFolderHolds()
    {
        var folder = RecordTypeDispatch.For(Release).FolderNameFor("globalfloat")
            ?? throw new InvalidOperationException("Expected 'globalfloat' to resolve to a group folder.");
        var relativePath = Path.Combine("plugin-source", PluginName, folder, $"SomeGlobal - 000800_{PluginName}.json");
        var repository = Tracked(new TreeFile(relativePath, "{}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, relativePath), "{\"changed\":true}");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.True(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_APathWithNoPluginSourceRootAtAll_IsIgnoredEntirely_NotEvenACandidateForTheStructuralPass() =>
        AssertIgnoredEntirely("Test.esp/Npcs/000800.json");

    [Fact]
    public void DirtOf_APathUnderARootSegmentThatIsNotLiterallyPluginSource_IsIgnoredEntirely_NotEvenACandidateForTheStructuralPass() =>
        AssertIgnoredEntirely("NotPluginSource/Test.esp/Npcs/000800.json");

    private void AssertIgnoredEntirely(string relativePath)
    {
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);
        var repository = Tracked();

        Directory.CreateDirectory(Path.Combine(_modFolder, Path.GetDirectoryName(normalized) ?? ""));
        File.WriteAllText(Path.Combine(_modFolder, normalized), "{\"changed\":true}");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }
}
