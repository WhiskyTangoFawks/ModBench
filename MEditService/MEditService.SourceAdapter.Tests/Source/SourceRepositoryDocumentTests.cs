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

    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
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
        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Wrote();
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
        var document = Opened().RecordOf(Plugin, Npc).Value();

        Assert.NotNull(document);
        Assert.Equal(NpcBody, document.Body);
        Assert.Equal(NpcFormKey, document.FormKey);
        Assert.Equal("npc_", document.RecordType);
    }

    [Fact]
    public void Get_OfARecordNoFileHolds_IsNull()
    {
        Assert.Null(Opened().RecordOf(Plugin, new RecordIdentity("000801:Fixture.esp", "npc_", "Absent")).Value());
    }

    [Fact]
    public void Put_OfARecordTheTreeHasNeverHeld_ThenGet_RoundTripsItsText()
    {
        var repository = Opened();
        var weapon = new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon", "{\"EditorID\": \"FixtureWeapon\"}");

        repository.Put(Plugin, weapon).Wrote();

        Assert.Equal(weapon.Body, repository.RecordOf(Plugin, new RecordIdentity(weapon.FormKey, "weap", "FixtureWeapon")).Value()?.Body);
    }

    [Fact]
    public void Put_OverARecordTheTreeAlreadyHolds_ReplacesItsText()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, "{\"EditorID\": \"FixtureNpc\"}")).Wrote();

        Assert.Equal("{\"EditorID\": \"FixtureNpc\"}", repository.RecordOf(Plugin, Npc).Value()?.Body);
    }

    [Fact]
    public void Remove_OfARecordTheTreeHolds_LeavesNoFileHoldingIt()
    {
        var repository = Opened();

        repository.Remove(Plugin, Npc).Wrote();

        Assert.Null(repository.RecordOf(Plugin, Npc).Value());
        Assert.Empty(Directory.EnumerateFiles(NpcGroupFolder));
    }

    [PosixFact]
    public void Remove_OfAFlatRecordWhoseFileCannotBeRead_StillDeletesIt()
    {
        var repository = Opened();
        var file = Directory.EnumerateFiles(NpcGroupFolder).Single();
        FileModes.Set(file, "000");

        repository.Remove(Plugin, Npc).Wrote();

        Assert.Empty(Directory.EnumerateFiles(NpcGroupFolder));
    }

    [Fact]
    public void Remove_OfARecordNoFileHolds_IsTheStateItAsksFor_NotAThrow_ThoughNotEvenItsGroupFolderExists()
    {
        var repository = Opened();

        repository.Remove(Plugin, new RecordIdentity("000900:Fixture.esp", "weap", "Absent")).Wrote();

        Assert.NotNull(repository.RecordOf(Plugin, Npc).Value());
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

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc"))).Wrote();

        Assert.Equal([$"RenamedNpc - 000800_{PluginName}.json"], NpcFileNames());
        Assert.Equal(
            WithEditorId("RenamedNpc"),
            repository.RecordOf(Plugin, new RecordIdentity(NpcFormKey, "npc_", "RenamedNpc")).Value()?.Body);
    }

    [Fact]
    public void Put_WithAnEditorIdTooLongForAPath_NamesTheFileByACappedEditorId()
    {
        var repository = Opened();
        var longId = new string('A', 300);

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", longId, WithEditorId(longId))).Wrote();

        Assert.Equal([$"{new string('A', 64)} - 000800_{PluginName}.json"], NpcFileNames());
        Assert.Equal(WithEditorId(longId), repository.RecordOf(Plugin, new RecordIdentity(NpcFormKey, "npc_", longId)).Value()?.Body);
    }

    [Fact]
    public void Put_WithANewEditorId_LeavesOneStampAtTheFormKey_ForTheNewBody()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc"))).Wrote();

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

        Assert.Equal(NpcBody, repository.RecordOf(Plugin, Npc).Value()?.Body);
    }

    [Fact]
    public void Put_WithANewEditorIdOnACell_MovesItsDirectoryAndKeepsItsBlockFolders()
    {
        const string cellKey = "000A00:Fixture.esp";
        PluginBaselines.TrackWithNoRecords(_modFolder);
        var repository = RequireOpened();
        static string CellBody(string editorId) => $"{{\n  \"FormKey\": \"{cellKey}\",\n  \"EditorID\": \"{editorId}\"\n}}";
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "OldCell", CellBody("OldCell"))).Wrote();
        var cells = Path.Combine(_modFolder, "plugin-source", PluginName, "Cells");
        var oldLeaf = Directory.GetDirectories(cells, "OldCell*", SearchOption.AllDirectories).Single();
        var blockFolder = Path.GetDirectoryName(oldLeaf) ?? throw new InvalidOperationException(oldLeaf);

        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "NewCell", CellBody("NewCell"))).Wrote();

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
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body)).Wrote();
        var cells = Path.Combine(_modFolder, "plugin-source", PluginName, "Cells");
        var held = Directory.GetDirectories(cells, "Cell*", SearchOption.AllDirectories).Single();
        var blockFolder = Path.GetDirectoryName(held) ?? throw new InvalidOperationException(held);
        Directory.Move(held, Path.Combine(blockFolder, $"RenamedOutside - 000A00_{PluginName}"));

        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body)).Wrote();

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
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body)).Wrote();
        var directory = Directory.GetDirectories(Path.Combine(_modFolder, "plugin-source", PluginName, "Cells"), "Cell*", SearchOption.AllDirectories).Single();
        File.Move(PluginSourceRoot.ContainerDocument(directory), Path.Combine(directory, heldAs));

        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body)).Wrote();

        Assert.Equal([PluginSourceRoot.ContainerDocument(directory)], Directory.GetFiles(directory));
    }

    [Fact]
    public void Put_OfACellWhoseDirectoryHoldsTwoDocumentsAndNoneNamedForIt_RefusesAsAmbiguous()
    {
        const string cellKey = "000A00:Fixture.esp";
        PluginBaselines.TrackWithNoRecords(_modFolder);
        var repository = RequireOpened();
        var body = $"{{\n  \"FormKey\": \"{cellKey}\",\n  \"EditorID\": \"Cell\"\n}}";
        repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body)).Wrote();
        var directory = Directory.GetDirectories(Path.Combine(_modFolder, "plugin-source", PluginName, "Cells"), "Cell*", SearchOption.AllDirectories).Single();
        File.Move(PluginSourceRoot.ContainerDocument(directory), Path.Combine(directory, "One.json"));
        File.WriteAllText(Path.Combine(directory, "Two.json"), body);

        Assert.IsType<SourceFailure.Ambiguous>(repository.Put(Plugin, new SourceDocument(cellKey, "cell", "Cell", body)).Failed());
    }

    [Fact]
    public void ChangesToRewrite_OfAFileTheGivenTextWasFoundCarryingUnderANameCarryingNoFormKey_MovesItToTheNameTheLayoutComputes()
    {
        var repository = Opened();
        var handName = Path.Combine(NpcGroupFolder, "HandName.json");
        var layoutName = Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json");
        File.Move(layoutName, handName);
        Assert.NotNull(repository.CarryingFromText(Plugin, NpcFormKey, NpcBody).Value());

        var changes = repository.ChangesToRewrite(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Value();

        Assert.Equal([new SourceMove(Path.GetRelativePath(_modFolder, handName), Path.GetRelativePath(_modFolder, layoutName))], changes.Moves);
    }

    [Fact]
    public void Put_OfAFileFoundByItsTextUnderANameCarryingNoFormKey_MovesItToTheNameTheLayoutComputes()
    {
        var repository = Opened();
        File.Move(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"), Path.Combine(NpcGroupFolder, "HandName.json"));
        var identity = new RecordIdentity(NpcFormKey, "npc_", NpcEditorId);
        Assert.NotNull(repository.RecordOf(Plugin, identity).Value());

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Wrote();

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

        Assert.IsType<SourceFailure.Ambiguous>(repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Failed());

        Assert.Equal(before, (File.ReadAllText(atLayoutName), File.ReadAllText(renamed)));
    }

    [Theory]
    [InlineData(NpcFormKey, "npc_", NpcEditorId)]
    [InlineData("000900:Fixture.esp", "cell", "FreshCell")]
    public void ChangesToRewrite_OfARecordNoDocumentHolds_RefusesNamingIt(string formKey, string recordType, string editorId)
    {
        var repository = Opened();
        File.Delete(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"));

        var refusal = Assert.IsType<SourceFailure.NotCarried>(repository.ChangesToRewrite(
            Plugin, new SourceDocument(formKey, recordType, editorId, $"{{\n  \"FormKey\": \"{formKey}\"\n}}")).Stopped());

        Assert.Contains(formKey, refusal.Reason, StringComparison.Ordinal);
        Assert.EndsWith("It was moved or removed outside Modbench. Check the Source Control panel.", refusal.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Put_OverADocumentThatIsNotJson_RefusesWithAReason_AndLeavesTheFileAsItWas()
    {
        var repository = Opened();
        var file = Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json");
        File.WriteAllText(file, "this is not a document");

        var refusal = Assert.IsType<SourceFailure.Unreadable>(repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc"))).Failed());

        Assert.Contains("not a readable document", refusal.Reason, StringComparison.Ordinal);
        Assert.Equal("this is not a document", File.ReadAllText(file));
        Assert.Equal([Path.GetFileName(file)], NpcFileNames());
    }

    [Fact]
    public void Put_OfAFileSomethingElseRenamed_MovesItToTheNameTheLayoutComputes()
    {
        var repository = Opened();
        var renamed = Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json");
        File.Move(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"), renamed);

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Wrote();

        Assert.Equal([$"{NpcEditorId} - 000800_{PluginName}.json"], NpcFileNames());
    }

    [Fact]
    public void Get_WhenTwoFilesInTheGroupFolderClaimOneFormKey_Refuses_ForAFormKeyIsUniqueInAModSoEitherAnswerIsAGuess()
    {
        var repository = Opened();
        File.WriteAllText(Path.Combine(NpcGroupFolder, $"AnImpostor - 000800_{PluginName}.json"), NpcBody);

        var refusal = Assert.IsType<SourceFailure.Ambiguous>(repository.RecordOf(Plugin, new RecordIdentity(NpcFormKey, "npc_", "NeitherName")).Stopped());

        Assert.Contains(NpcFormKey, refusal.Reason, StringComparison.Ordinal);
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

        Assert.Equal("{\"MasterReferences\": []}", repository.RecordOf(Plugin, header).Value()?.Body);
    }

    private static readonly PluginAddress TheSameNameFromAnotherMod = Plugin with { Origin = "OtherMod" };

    [Fact]
    public void Get_OfAPluginAnotherModProvides_IsRefusedAsNoneOfThisRepositorys()
    {
        var repository = Opened();

        Assert.Throws<ArgumentException>(() => repository.Get(TheSameNameFromAnotherMod, NpcFormKey));
    }

    [Fact]
    public void Put_OfAPluginAnotherModProvides_IsRefusedAndWritesNothing()
    {
        var repository = Opened();
        var before = TreeSnapshot.Of(_modFolder);

        Assert.Throws<ArgumentException>(() => repository.Put(TheSameNameFromAnotherMod, new SourceDocument(NpcFormKey, "npc_", "Theirs", NpcBody)));

        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void Remove_OfAPluginAnotherModProvides_IsRefusedAndRemovesNothing()
    {
        var repository = Opened();
        var before = TreeSnapshot.Of(_modFolder);

        Assert.Throws<ArgumentException>(() => repository.Remove(TheSameNameFromAnotherMod, Npc));

        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void WhyUnreadable_OfTextThatIsNoDocument_SaysTheRecordsSourceIsNoReadableDocument()
    {
        var repository = Opened();

        var refused = Assert.IsType<SourceFailure.Unreadable>(repository.WhyUnreadable(Plugin, Npc, "this is not a document"));

        Assert.Equal($"The source of {NpcFormKey} in {PluginName} ({Plugin.Origin}) is not a readable document.", refused.Reason);
    }

    [Fact]
    public void WhyUnreadable_OfTheRecordsOwnReadableText_IsNothing()
    {
        Assert.Null(Opened().WhyUnreadable(Plugin, Npc, NpcBody));
    }
}
