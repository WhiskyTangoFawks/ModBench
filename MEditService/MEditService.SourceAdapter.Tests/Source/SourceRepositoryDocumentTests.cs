using MEditService.Codec.Schema;
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

    private ISourceRepository RequireOpened() =>
        TestAdapters.OpenSourceMod(_modFolder, GameRelease.Fallout4);

    private void Init(params TreeFile[] files) =>
        PluginBaselines.Init(
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

    private ISourceRepository Opened()
    {
        PluginBaselines.InitWithNoRecords(_modFolder);
        var repository = RequireOpened();
        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Wrote();
        return repository;
    }

    [PosixFact]
    public async Task PuttingARecordNoDocumentHolds_ReadsNoOtherDocument()
    {
        Opened();
        var pipeWhoseOpenForReadingNeverReturnsUntilSomethingWritesToIt = Path.Combine(NpcGroupFolder, "Unnamed.json");
        MakeFifo(pipeWhoseOpenForReadingNeverReturnsUntilSomethingWritesToIt);

        var put = Task.Run(() => RequireOpened().Put(
            Plugin, new SourceDocument("000A00:Fixture.esp", "npc_", "Created", "{\"FormKey\": \"000A00:Fixture.esp\"}")));

        Assert.True(
            await FinishesUnblocked(put, pipeWhoseOpenForReadingNeverReturnsUntilSomethingWritesToIt),
            "Put opened another document to place a record no document holds.");
    }

    private static async Task<bool> FinishesUnblocked(Task put, string pipe)
    {
        try
        {
            await put.WaitAsync(TimeSpan.FromSeconds(10));
            return true;
        }
        catch (TimeoutException)
        {
            await UnblockEveryReaderByOpeningThePipeReadWriteAndClosingItToGiveEndOfFile(pipe, put);
            await put;
            return false;
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
    public void AFolderThatIsNoSourceMod_OpensNoRepository()
    {
        Assert.Null(TestAdapters.Source().Open(TestMod.In(_modFolder), GameRelease.Fallout4));
    }

    [Fact]
    public void AFlatRecordTheTreeHolds_IsItsOwnText()
    {
        var document = Opened().RecordOf(Plugin, Npc).Value();

        Assert.NotNull(document);
        Assert.Equal(NpcBody, document.Body);
        Assert.Equal(NpcFormKey, document.FormKey);
        Assert.Equal("npc_", document.RecordType);
    }

    [Fact]
    public void ARecordNoFileHolds_HasNoText()
    {
        Assert.Null(Opened().RecordOf(Plugin, new RecordIdentity("000801:Fixture.esp", "npc_", "Absent")).Value());
    }

    [Fact]
    public void ARecordTheTreeHasNeverHeld_ReadsBackAsTheTextPut()
    {
        var repository = Opened();
        var weapon = new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon", "{\"EditorID\": \"FixtureWeapon\"}");

        repository.Put(Plugin, weapon).Wrote();

        Assert.Equal(weapon.Body, repository.RecordOf(Plugin, new RecordIdentity(weapon.FormKey, "weap", "FixtureWeapon")).Value()?.Body);
    }

    [Fact]
    public void PuttingARecordTheTreeAlreadyHolds_ReplacesItsText()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, "{\"EditorID\": \"FixtureNpc\"}")).Wrote();

        Assert.Equal("{\"EditorID\": \"FixtureNpc\"}", repository.RecordOf(Plugin, Npc).Value()?.Body);
    }

    [Fact]
    public void RemovingARecordTheTreeHolds_DeletesItsFile_AndWritesNothing()
    {
        var repository = Opened();
        var file = Directory.EnumerateFiles(NpcGroupFolder).Single();

        var changes = repository.ChangesToRemove(Plugin, Npc).Value();

        Assert.Equal([Path.GetRelativePath(_modFolder, file)], changes.Deletions);
        Assert.Empty(changes.Moves);
        Assert.Empty(changes.Documents);
        Assert.True(File.Exists(file));
    }

    [PosixFact]
    public void RemovingAFlatRecordWhoseFileCannotBeRead_StillDeletesIt()
    {
        var repository = Opened();
        var file = Directory.EnumerateFiles(NpcGroupFolder).Single();
        FileModes.Set(file, "000");

        repository.Remove(Plugin, Npc).Wrote();

        Assert.Empty(Directory.EnumerateFiles(NpcGroupFolder));
    }

    [Theory]
    [InlineData("weap", "000900:Fixture.esp")]
    [InlineData(PluginHeader.RecordType, "000000:Fixture.esp")]
    public void RemovingAFlatRecordOrTheHeaderNoDocumentHolds_IsNotCarried(string recordType, string formKey)
    {
        var repository = Opened();

        var refused = Assert.IsType<SourceFailure.NotCarried>(
            repository.Remove(Plugin, new RecordIdentity(formKey, recordType, "Absent")).Failed());

        Assert.StartsWith($"No document in Fixture.esp's tree holds {formKey}, so there is none to remove.", refused.Reason, StringComparison.Ordinal);
    }

    private static string WithEditorId(string editorId) => NpcBody.Replace(NpcEditorId, editorId, StringComparison.Ordinal);

    private IEnumerable<string> NpcFileNames() =>
        Directory.EnumerateFiles(NpcGroupFolder).Select(Path.GetFileName).OfType<string>();

    private string RunGit(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    [Fact]
    public void ANewEditorId_MovesTheFileToTheNameTheLayoutComputes_WhereTheRecordIsStillFound()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc"))).Wrote();

        Assert.Equal([$"RenamedNpc - 000800_{PluginName}.json"], NpcFileNames());
        Assert.Equal(
            WithEditorId("RenamedNpc"),
            repository.RecordOf(Plugin, new RecordIdentity(NpcFormKey, "npc_", "RenamedNpc")).Value()?.Body);
    }

    [Fact]
    public void AnEditorIdTooLongForAPath_NamesTheFileByACappedEditorId()
    {
        var repository = Opened();
        var longId = new string('A', 300);

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", longId, WithEditorId(longId))).Wrote();

        Assert.Equal([$"{new string('A', 64)} - 000800_{PluginName}.json"], NpcFileNames());
        Assert.Equal(WithEditorId(longId), repository.RecordOf(Plugin, new RecordIdentity(NpcFormKey, "npc_", longId)).Value()?.Body);
    }

    [Fact]
    public void ANewEditorId_LeavesOneStampAtTheFormKey_ForTheNewBody()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc"))).Wrote();

        var stamps = repository.StampsOf(Plugin).ByFormKey;
        Assert.Equal(
            TestAdapters.Source().ContentStamp(WithEditorId("RenamedNpc")),
            stamps[NpcFormKey]);
    }

    [Fact]
    public void AFileAnotherToolOrTheAuthorRenamed_IsStillFoundByFormKey_ForTheIdentityNamesTheRecordInsideIt()
    {
        var repository = Opened();
        File.Move(
            Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"),
            Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json"));

        Assert.Equal(NpcBody, repository.RecordOf(Plugin, Npc).Value()?.Body);
    }

    private const string CellKey = "000A00:Fixture.esp";

    private static readonly string CellBody = CellBodyNamed("Cell");

    private static string CellBodyNamed(string editorId) => $"{{\n  \"FormKey\": \"{CellKey}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    [Fact]
    public void ANewEditorIdOnACell_MovesItsDirectory_AndKeepsItsBlockFolders()
    {
        var (repository, _, blockFolder) = AContainerPutInItsOwnDirectory();
        var renamed = Path.Combine(blockFolder, $"NewCell - 000A00_{PluginName}");

        repository.Put(Plugin, new SourceDocument(CellKey, "cell", "NewCell", CellBodyNamed("NewCell"))).Wrote();

        Assert.Equal([renamed], Directory.GetDirectories(blockFolder));
        Assert.Equal([PluginSourceRoot.ContainerDocument(renamed)], Directory.GetFiles(renamed));
        Assert.Equal(CellBodyNamed("NewCell"), File.ReadAllText(PluginSourceRoot.ContainerDocument(renamed)));
    }

    private (ISourceRepository Repository, string Directory, string BlockFolder) AContainerPutInItsOwnDirectory(
        string recordType = "cell", string groupFolder = "Cells")
    {
        PluginBaselines.InitWithNoRecords(_modFolder);
        var repository = RequireOpened();
        repository.Put(Plugin, new SourceDocument(CellKey, recordType, "Cell", CellBody)).Wrote();
        var directory = Directory.GetDirectories(Path.Combine(_modFolder, "plugin-source", PluginName, groupFolder), "Cell*", SearchOption.AllDirectories).Single();
        return (repository, directory, Path.GetDirectoryName(directory) ?? throw new InvalidOperationException(directory));
    }

    private static SourceFailure? PutTheContainer(ISourceRepository repository, string recordType = "cell") =>
        repository.Put(Plugin, new SourceDocument(CellKey, recordType, "Cell", CellBody));

    [Theory]
    [InlineData("cell", "Cells")]
    [InlineData("wrld", "Worldspaces")]
    public void AContainerDirectorySomethingElseRenamed_IsMovedByAPutToTheNameTheLayoutComputes(string recordType, string groupFolder)
    {
        var (repository, held, parent) = AContainerPutInItsOwnDirectory(recordType, groupFolder);
        Directory.Move(held, Path.Combine(parent, $"RenamedOutside - 000A00_{PluginName}"));

        PutTheContainer(repository, recordType).Wrote();

        Assert.Equal([Path.Combine(parent, $"Cell - 000A00_{PluginName}")], Directory.GetDirectories(parent));
    }

    [Theory]
    [InlineData("HandName.json")]
    [InlineData("HandName.JSON")]
    [InlineData("RecordData.json")]
    public void ACellDocumentNamedOtherwiseInItsOwnDirectory_IsMovedByAPutToTheLeafName(string heldAs)
    {
        var (repository, directory, _) = AContainerPutInItsOwnDirectory();
        File.Move(PluginSourceRoot.ContainerDocument(directory), Path.Combine(directory, heldAs));

        PutTheContainer(repository).Wrote();

        Assert.Equal([PluginSourceRoot.ContainerDocument(directory)], Directory.GetFiles(directory));
    }

    [Fact]
    public void PuttingACellWhoseDirectoryHoldsTwoDocumentsAndNoneNamedForIt_IsRefusedAsAmbiguous()
    {
        var (repository, directory, _) = AContainerPutInItsOwnDirectory();
        File.Move(PluginSourceRoot.ContainerDocument(directory), Path.Combine(directory, "One.json"));
        File.WriteAllText(Path.Combine(directory, "Two.json"), CellBody);

        Assert.IsType<SourceFailure.Ambiguous>(PutTheContainer(repository).Failed());
    }

    [Fact]
    public void RewritingAFileTheGivenTextWasFoundCarryingUnderANameCarryingNoFormKey_MovesItToTheNameTheLayoutComputes()
    {
        var repository = Opened();
        var handName = Path.Combine(NpcGroupFolder, "HandName.json");
        var layoutName = Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json");
        File.Move(layoutName, handName);
        Assert.NotNull(repository.RecordFromText(Plugin, NpcFormKey, NpcBody).Value());

        var changes = repository.ChangesToRewrite(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Value();

        Assert.Equal([new SourceMove(Path.GetRelativePath(_modFolder, handName), Path.GetRelativePath(_modFolder, layoutName))], changes.Moves);
    }

    [Fact]
    public void PuttingAFileRenamedByHandWhileAnotherHoldsTheLayoutsName_IsRefusedAndLeavesBothFiles()
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
    public void RewritingARecordNoDocumentHolds_IsRefusedNamingIt(string formKey, string recordType, string editorId)
    {
        var repository = Opened();
        File.Delete(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"));

        var refusal = Assert.IsType<SourceFailure.NotCarried>(repository.ChangesToRewrite(
            Plugin, new SourceDocument(formKey, recordType, editorId, $"{{\n  \"FormKey\": \"{formKey}\"\n}}")).Stopped());

        Assert.Contains(formKey, refusal.Reason, StringComparison.Ordinal);
        Assert.EndsWith("It was moved or removed outside Modbench. Check the Source Control panel.", refusal.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void PuttingOverADocumentThatIsNotJson_IsRefusedWithAReason_AndLeavesTheFileAsItWas()
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
    public void AFileSomethingElseRenamed_IsMovedByAPutToTheNameTheLayoutComputes()
    {
        var repository = Opened();
        var renamed = Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json");
        File.Move(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"), renamed);

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Wrote();

        Assert.Equal([$"{NpcEditorId} - 000800_{PluginName}.json"], NpcFileNames());
    }

    [Fact]
    public void ARecordTwoFilesInItsGroupFolderClaim_IsRefused_ForAFormKeyIsUniqueInAModSoEitherAnswerIsAGuess()
    {
        var repository = Opened();
        File.WriteAllText(Path.Combine(NpcGroupFolder, $"AnImpostor - 000800_{PluginName}.json"), NpcBody);

        var refusal = Assert.IsType<SourceFailure.Ambiguous>(repository.RecordOf(Plugin, new RecordIdentity(NpcFormKey, "npc_", "NeitherName")).Stopped());

        Assert.Contains(NpcFormKey, refusal.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void TheHeadersText_IsTheRootRecordDocument()
    {
        Init(
            new TreeFile(
                PluginSourceRoot.HeaderDocument(PluginName),
                System.Text.Encoding.UTF8.GetBytes("{\"MasterReferences\": []}")));
        var repository = RequireOpened();

        var header = new RecordIdentity($"000000:{PluginName}", "header", null);

        Assert.Equal("{\"MasterReferences\": []}", repository.RecordOf(Plugin, header).Value()?.Body);
    }

    private static readonly PluginAddress TheSameNameFromAnotherMod = Plugin with { Origin = "OtherMod" };

    public enum Verb
    {
        RecordByFormKey,
        Put,
        Remove,
        WriteBinary,
        LastWrittenBinarySha256s,
        ReplaceSourceFrom,
    }

    private static Action OnTheOtherModsPlugin(ISourceRepository repository, Verb verb) =>
        verb switch
        {
            Verb.RecordByFormKey => () => repository.RecordByFormKey(TheSameNameFromAnotherMod, NpcFormKey),
            Verb.Put => () => repository.Put(TheSameNameFromAnotherMod, new SourceDocument(NpcFormKey, "npc_", "Theirs", NpcBody)),
            Verb.Remove => () => repository.Remove(TheSameNameFromAnotherMod, Npc),
            Verb.WriteBinary => () => repository.WriteBinary(TheSameNameFromAnotherMod, "ABC", () => { }),
            Verb.LastWrittenBinarySha256s => () => repository.LastWrittenBinarySha256s(TheSameNameFromAnotherMod),
            Verb.ReplaceSourceFrom => () => repository.ReplaceSourceFrom(TheSameNameFromAnotherMod, [], "ABC"),
            _ => throw new ArgumentOutOfRangeException(nameof(verb), verb, null),
        };

    [Theory]
    [InlineData(Verb.RecordByFormKey)]
    [InlineData(Verb.Put)]
    [InlineData(Verb.Remove)]
    [InlineData(Verb.WriteBinary)]
    [InlineData(Verb.LastWrittenBinarySha256s)]
    [InlineData(Verb.ReplaceSourceFrom)]
    public void AVerbOnAPluginAnotherModProvides_IsRefusedAndWritesNothing(Verb verb)
    {
        var repository = Opened();
        var before = TreeSnapshot.Of(_modFolder);

        Assert.Throws<ArgumentException>(OnTheOtherModsPlugin(repository, verb));

        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
        Assert.Empty(repository.LastWrittenBinarySha256s(Plugin).Value());
    }

    [Fact]
    public void TextThatIsNoDocument_IsUnreadable_AsTheRecordsSource()
    {
        var repository = Opened();

        var refused = Assert.IsType<SourceFailure.Unreadable>(repository.WhyUnreadable(Plugin, Npc, "this is not a document"));

        Assert.Equal($"The source of {NpcFormKey} in {PluginName} ({Plugin.Origin}) is not a readable document.", refused.Reason);
    }

    [Fact]
    public void TheRecordsOwnReadableText_IsReadable()
    {
        Assert.Null(Opened().WhyUnreadable(Plugin, Npc, NpcBody));
    }
}
