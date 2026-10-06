using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryDocumentTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "FixtureMod");
    private static readonly RecordIdentity Npc = new(NpcFormKey, "npc_", NpcEditorId);

    private readonly ScratchDirectory _modFolder = new("medit-repository-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository RequireOpened() =>
        SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private void Track(params TreeFile[] files) =>
        PluginBaselines.Track(
            _modFolder, files);

    private string NpcGroupFolder
    {
        get
        {
            var documentPath = SourceDocumentPath.Of(_modFolder, PluginName, "npc_", NpcFormKey, NpcEditorId, GameRelease.Fallout4);
            return Path.GetDirectoryName(documentPath)
                ?? throw new InvalidOperationException($"Expected '{documentPath}' to have a parent directory.");
        }
    }

    private SourceRepository Opened()
    {
        PluginBaselines.TrackWithNoRecords(_modFolder);
        var repository = RequireOpened();
        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody));
        return repository;
    }

    [Fact]
    public async Task Put_OfARecordNoDocumentHolds_ReadsNoOtherDocument()
    {
        Opened();
        var pipeWhoseOpenForReadingNeverReturnsUntilSomethingWritesToIt = Path.Combine(NpcGroupFolder, "Unnamed.json");
        MakeFifo(pipeWhoseOpenForReadingNeverReturnsUntilSomethingWritesToIt);

        var put = Task.Run(() => RequireOpened().Put(
            Plugin, new SourceDocument("000A00:Fixture.esp", "npc_", "Created", "{\"FormKey\": \"000A00:Fixture.esp\"}")));

        try
        {
            await put.WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch (TimeoutException)
        {
            await UnblockEveryReaderByOpeningThePipeReadWriteAndClosingItToGiveEndOfFile(
                pipeWhoseOpenForReadingNeverReturnsUntilSomethingWritesToIt, put);
            await put;
            Assert.Fail("Put opened another document to place a record no document holds.");
        }
    }

    private static async Task UnblockEveryReaderByOpeningThePipeReadWriteAndClosingItToGiveEndOfFile(string pipe, Task until)
    {
        while (!until.IsCompleted)
        {
            await using (new FileStream(pipe, FileMode.Open, FileAccess.ReadWrite))
            {
                await Task.WhenAny(until, Task.Delay(TimeSpan.FromMilliseconds(100)));
            }
        }
    }

    private static void MakeFifo(string path)
    {
        using var mkfifo = System.Diagnostics.Process.Start(
            new System.Diagnostics.ProcessStartInfo("mkfifo", [path]) { RedirectStandardError = true })
            ?? throw new InvalidOperationException($"Expected 'mkfifo {path}' to start a process.");
        mkfifo.WaitForExit();
        if (mkfifo.ExitCode != 0)
            throw new InvalidOperationException($"mkfifo {path} failed: {mkfifo.StandardError.ReadToEnd()}");
    }

    [Fact]
    public void Open_OnAnUntrackedFolder_IsNull()
    {
        Assert.Null(SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4));
    }

    [Fact]
    public void Open_OnATrackedFolder_IsARepository()
    {
        PluginBaselines.TrackWithNoRecords(_modFolder);

        Assert.NotNull(SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4));
    }

    [Fact]
    public void Get_OfAFlatRecordTheTreeHolds_IsItsOwnText()
    {
        var document = Opened().Get(Plugin, Npc);

        Assert.NotNull(document);
        Assert.Equal(NpcBody, document.Body);
        Assert.Equal(NpcFormKey, document.FormKey);
        Assert.Equal("npc_", document.RecordType);
    }

    [Fact]
    public void Get_OfARecordNoFileHolds_IsNull()
    {
        Assert.Null(Opened().Get(Plugin, new RecordIdentity("000801:Fixture.esp", "npc_", "Absent")));
    }

    [Fact]
    public void Put_OfARecordTheTreeHasNeverHeld_ThenGet_RoundTripsItsText()
    {
        var repository = Opened();
        var weapon = new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon", "{\"EditorID\": \"FixtureWeapon\"}");

        repository.Put(Plugin, weapon);

        Assert.Equal(weapon.Body, repository.Get(Plugin, new RecordIdentity(weapon.FormKey, "weap", "FixtureWeapon"))?.Body);
    }

    [Fact]
    public void Put_OverARecordTheTreeAlreadyHolds_ReplacesItsText()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, "{\"EditorID\": \"FixtureNpc\"}"));

        Assert.Equal("{\"EditorID\": \"FixtureNpc\"}", repository.Get(Plugin, Npc)?.Body);
    }

    [Fact]
    public void Remove_OfARecordTheTreeHolds_LeavesNoFileHoldingIt()
    {
        var repository = Opened();

        repository.Remove(Plugin, Npc);

        Assert.Null(repository.Get(Plugin, Npc));
        Assert.Empty(Directory.EnumerateFiles(NpcGroupFolder));
    }

    [Fact]
    public void Remove_OfARecordNoFileHolds_IsTheStateItAsksFor_NotAThrow_ThoughNotEvenItsGroupFolderExists()
    {
        var repository = Opened();

        repository.Remove(Plugin, new RecordIdentity("000900:Fixture.esp", "weap", "Absent"));

        Assert.NotNull(repository.Get(Plugin, Npc));
    }

    private static string WithEditorId(string editorId) => NpcBody.Replace(NpcEditorId, editorId, StringComparison.Ordinal);

    private IEnumerable<string> NpcFileNames() =>
        Directory.EnumerateFiles(NpcGroupFolder).Select(Path.GetFileName).OfType<string>();

    private string RunGit(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    [Fact]
    public void Put_WithANewEditorId_MovesTheFileToTheNameItComputes_AndGetStillFindsItByFormKey()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc")));

        Assert.Equal([$"RenamedNpc - 000800_{PluginName}.json"], NpcFileNames());
        Assert.Equal(
            WithEditorId("RenamedNpc"),
            repository.Get(Plugin, new RecordIdentity(NpcFormKey, "npc_", "RenamedNpc"))?.Body);
    }

    [Fact]
    public void Put_WithAnEditorIdTooLongForAPath_NamesTheFileByACappedEditorId()
    {
        var repository = Opened();
        var longId = new string('A', 300);

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", longId, WithEditorId(longId)));

        Assert.Equal([$"{new string('A', 64)} - 000800_{PluginName}.json"], NpcFileNames());
        Assert.Equal(WithEditorId(longId), repository.Get(Plugin, new RecordIdentity(NpcFormKey, "npc_", longId))?.Body);
    }

    [Fact]
    public void Put_WithANewEditorId_LeavesOneStampAtTheFormKey_ForTheNewBody()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc")));

        var stamps = repository.StampsOf(Plugin).ByFormKey;
        Assert.Equal(
            SourceRepository.ContentStamp(WithEditorId("RenamedNpc")),
            stamps[NpcFormKey]);
    }

    [Fact]
    public void Get_AfterAnotherToolOrTheAuthorRenamedTheFile_StillFindsItByFormKey_ForTheIdentityNamesTheRecordInsideIt()
    {
        var repository = Opened();
        File.Move(
            Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"),
            Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json"));

        Assert.Equal(NpcBody, repository.Get(Plugin, Npc)?.Body);
    }

    [Fact]
    public void Put_WithANewEditorIdOnACell_MovesItsDirectoryAndKeepsItsBlockFolders()
    {
        const string cellKey = "000A00:Fixture.esp";
        PluginBaselines.TrackWithNoRecords(_modFolder);
        var repository = RequireOpened();
        static string CellBody(string editorId) => $"{{\n  \"FormKey\": \"{cellKey}\",\n  \"EditorID\": \"{editorId}\"\n}}";
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "OldCell", CellBody("OldCell")));
        var cells = Path.Combine(_modFolder, "plugin-source", PluginName, "Cells");
        var oldLeaf = Directory.GetDirectories(cells, "OldCell*", SearchOption.AllDirectories).Single();
        var blockFolder = Path.GetDirectoryName(oldLeaf) ?? throw new InvalidOperationException(oldLeaf);

        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "NewCell", CellBody("NewCell")));

        Assert.Equal(
            [Path.Combine(blockFolder, $"NewCell - 000A00_{PluginName}")],
            Directory.GetDirectories(blockFolder));
        Assert.Equal(
            CellBody("NewCell"),
            File.ReadAllText(PluginSourceRoot.ContainerDocument(Path.Combine(blockFolder, $"NewCell - 000A00_{PluginName}"))));
        Assert.Single(Directory.GetFiles(Path.Combine(blockFolder, $"NewCell - 000A00_{PluginName}")));
    }

    [Fact]
    public void Put_OfACellDirectorySomethingElseRenamed_MovesItToTheNameTheLayoutComputes()
    {
        const string cellKey = "000A00:Fixture.esp";
        PluginBaselines.TrackWithNoRecords(_modFolder);
        var repository = RequireOpened();
        var body = $"{{\n  \"FormKey\": \"{cellKey}\",\n  \"EditorID\": \"Cell\"\n}}";
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body));
        var cells = Path.Combine(_modFolder, "plugin-source", PluginName, "Cells");
        var held = Directory.GetDirectories(cells, "Cell*", SearchOption.AllDirectories).Single();
        var blockFolder = Path.GetDirectoryName(held) ?? throw new InvalidOperationException(held);
        Directory.Move(held, Path.Combine(blockFolder, $"RenamedOutside - 000A00_{PluginName}"));

        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body));

        Assert.Equal([Path.Combine(blockFolder, $"Cell - 000A00_{PluginName}")], Directory.GetDirectories(blockFolder));
    }

    [Theory]
    [InlineData("HandName.json")]
    [InlineData("HandName.JSON")]
    [InlineData("RecordData.json")]
    public void Put_OfACellWhoseDocumentIsNamedOtherwiseInItsOwnDirectory_MovesTheDocumentToTheLeafName(string heldAs)
    {
        const string cellKey = "000A00:Fixture.esp";
        PluginBaselines.TrackWithNoRecords(_modFolder);
        var repository = RequireOpened();
        var body = $"{{\n  \"FormKey\": \"{cellKey}\",\n  \"EditorID\": \"Cell\"\n}}";
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body));
        var directory = Directory.GetDirectories(Path.Combine(_modFolder, "plugin-source", PluginName, "Cells"), "Cell*", SearchOption.AllDirectories).Single();
        File.Move(PluginSourceRoot.ContainerDocument(directory), Path.Combine(directory, heldAs));

        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body));

        Assert.Equal([PluginSourceRoot.ContainerDocument(directory)], Directory.GetFiles(directory));
    }

    [Fact]
    public void Put_OfACellWhoseDirectoryHoldsTwoDocumentsAndNoneNamedForIt_RefusesAsAmbiguous()
    {
        const string cellKey = "000A00:Fixture.esp";
        PluginBaselines.TrackWithNoRecords(_modFolder);
        var repository = RequireOpened();
        var body = $"{{\n  \"FormKey\": \"{cellKey}\",\n  \"EditorID\": \"Cell\"\n}}";
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body));
        var directory = Directory.GetDirectories(Path.Combine(_modFolder, "plugin-source", PluginName, "Cells"), "Cell*", SearchOption.AllDirectories).Single();
        File.Move(PluginSourceRoot.ContainerDocument(directory), Path.Combine(directory, "One.json"));
        File.WriteAllText(Path.Combine(directory, "Two.json"), body);

        Assert.Throws<AmbiguousSourceUnitException>(() => repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body)));
    }

    [Fact]
    public void Put_OfAFileFoundByItsTextUnderANameCarryingNoFormKey_MovesItToTheNameTheLayoutComputes()
    {
        var repository = Opened();
        File.Move(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"), Path.Combine(NpcGroupFolder, "HandName.json"));
        var identity = new RecordIdentity(NpcFormKey, "npc_", NpcEditorId);
        Assert.NotNull(repository.Get(Plugin, identity));

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody));

        Assert.Equal([$"{NpcEditorId} - 000800_{PluginName}.json"], NpcFileNames());
    }

    [Fact]
    public void Put_OfAFileRenamedByHandWhileAnotherHoldsTheLayoutsName_RefusesAndLeavesBothFiles()
    {
        var repository = Opened();
        var atLayoutName = Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json");
        var renamed = Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json");
        File.Copy(atLayoutName, renamed);
        File.WriteAllText(atLayoutName, NpcBody.Replace("FixtureNpc", "Another", StringComparison.Ordinal));
        var before = (File.ReadAllText(atLayoutName), File.ReadAllText(renamed));

        Assert.Throws<AmbiguousSourceUnitException>(
            () => repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)));

        Assert.Equal(before, (File.ReadAllText(atLayoutName), File.ReadAllText(renamed)));
    }

    [Theory]
    [InlineData(NpcFormKey, "npc_", NpcEditorId)]
    [InlineData("000900:Fixture.esp", "cell", "FreshCell")]
    public void ChangesToRewrite_OfARecordNoDocumentHolds_RefusesNamingIt(string formKey, string recordType, string editorId)
    {
        var repository = Opened();
        File.Delete(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"));

        var refusal = Assert.Throws<SourceUnitNotFoundException>(() => repository.ChangesToRewrite(
            Plugin, new SourceDocument(formKey, recordType, editorId, $"{{\n  \"FormKey\": \"{formKey}\"\n}}")));

        Assert.Contains(formKey, refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Put_OverADocumentThatIsNotJson_RefusesWithAReason_AndLeavesTheFileAsItWas()
    {
        var repository = Opened();
        var file = Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json");
        File.WriteAllText(file, "this is not a document");

        var refusal = Assert.Throws<UnreadableSourceDocumentException>(
            () => repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc"))));

        Assert.Contains("not a readable document", refusal.Message, StringComparison.Ordinal);
        Assert.Equal("this is not a document", File.ReadAllText(file));
        Assert.Equal([Path.GetFileName(file)], NpcFileNames());
    }

    [Fact]
    public void Put_OfAFileSomethingElseRenamed_MovesItToTheNameTheLayoutComputes()
    {
        var repository = Opened();
        var renamed = Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json");
        File.Move(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"), renamed);

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody));

        Assert.Equal([$"{NpcEditorId} - 000800_{PluginName}.json"], NpcFileNames());
    }

    [Fact]
    public void Get_WhenTwoFilesInTheGroupFolderClaimOneFormKey_Refuses_ForAFormKeyIsUniqueInAModSoEitherAnswerIsAGuess()
    {
        var repository = Opened();
        File.WriteAllText(Path.Combine(NpcGroupFolder, $"AnImpostor - 000800_{PluginName}.json"), NpcBody);

        var refusal = Assert.Throws<AmbiguousSourceUnitException>(
            () => repository.Get(Plugin, new RecordIdentity(NpcFormKey, "npc_", "NeitherName")));

        Assert.Contains(NpcFormKey, refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfTheHeader_IsTheRootRecordDocument()
    {
        Track(
            new TreeFile(
                PluginSourceRoot.HeaderDocument(PluginName),
                System.Text.Encoding.UTF8.GetBytes("{\"MasterReferences\": []}")));
        var repository = RequireOpened();

        var header = new RecordIdentity($"000000:{PluginName}", "header", null);

        Assert.Equal("{\"MasterReferences\": []}", repository.Get(Plugin, header)?.Body);
    }
}
