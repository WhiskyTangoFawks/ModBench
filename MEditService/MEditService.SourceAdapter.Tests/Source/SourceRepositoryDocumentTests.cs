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

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-repository-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private SourceRepository RequireOpened() =>
        SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    // Track rather than a hand-made .git: the repository the tests open is the one the product makes.
    private void Track(params TreeFile[] files) =>
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits, files);

    // Asserted against directly: "the file moved" and "the file is gone" are claims about the tree,
    // and asking the repository for them would only echo its own rule back.
    private string NpcGroupFolder
    {
        get
        {
            var documentPath = SourceDocumentPath.Of(_modFolder, PluginName, "npc_", NpcFormKey, NpcEditorId, GameRelease.Fallout4);
            return Path.GetDirectoryName(documentPath)
                ?? throw new InvalidOperationException($"Expected '{documentPath}' to have a parent directory.");
        }
    }

    // Tracks an empty tree, then puts the fixture's NPC through the repository — the same door a real
    // edit uses — so its file lands wherever the repository's own placement decides.
    private SourceRepository Opened()
    {
        Track();
        var repository = RequireOpened();
        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody));
        return repository;
    }

    // A pipe nothing writes to never returns from an open for reading, so a Put that read the document
    // standing beside the new one would not return either.
    [Fact]
    public async Task Put_OfARecordNoDocumentHolds_ReadsNoOtherDocument()
    {
        Opened();
        var pipe = Path.Combine(NpcGroupFolder, "Unnamed.json");
        MakeFifo(pipe);

        var put = Task.Run(() => RequireOpened().Put(
            Plugin, new SourceDocument("000A00:Fixture.esp", "npc_", "Created", "{\"FormKey\": \"000A00:Fixture.esp\"}")));

        try
        {
            await put.WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch (TimeoutException)
        {
            await ReleaseEveryReaderOf(pipe, put);
            Assert.Fail("Put opened another document to place a record no document holds.");
        }
    }

    // Opened for both reading and writing, a pipe lets a waiting reader's open return, and closing it
    // hands that reader an end of file.
    private static async Task ReleaseEveryReaderOf(string pipe, Task until)
    {
        while (!until.IsCompleted)
        {
            await using (new FileStream(pipe, FileMode.Open, FileAccess.ReadWrite))
            {
                try
                {
                    await until.WaitAsync(TimeSpan.FromMilliseconds(100));
                }
                catch (TimeoutException)
                {
                    // Still reading: this handle closes and the next one lets the next open return.
                }
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
        Assert.Null(SourceRepository.Open(_modFolder, GameRelease.Fallout4));
    }

    [Fact]
    public void Open_OnATrackedFolder_IsARepository()
    {
        Track();

        Assert.NotNull(SourceRepository.Open(_modFolder, GameRelease.Fallout4));
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
    public void Remove_OfARecordNoFileHolds_IsTheStateItAsksFor_NotAThrow()
    {
        var repository = Opened();

        // A type this plugin has never held, so not even its group folder exists — the shape a hand
        // delete or another tool leaves behind.
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
    public void Put_WithANewEditorId_LeavesTheNextValidationOneChangedDocumentAtTheNewPathAndTheOldOneGone()
    {
        var repository = Opened();
        RunGit("add", "-A");
        RunGit("commit", "-q", "-m", "baseline");
        var validated = repository.ChangesSince(Plugin, validatedHead: null).Head.Require();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc")));

        var changed = repository.ChangesSince(Plugin, validated).Documents.Require();
        Assert.Equal(2, changed.Count);
        Assert.All(changed, document => Assert.Equal(NpcFormKey, document.FormKey));
        Assert.Single(changed, document => document.WorkingTreeText == null);
        Assert.Single(changed, document => document.WorkingTreeText == WithEditorId("RenamedNpc"));
    }

    [Fact]
    public void Get_AfterSomethingElseRenamedTheFile_StillFindsItByFormKey()
    {
        var repository = Opened();
        // Never assume exclusive ownership: xEdit, MO2 or the author can rename the file at any time,
        // and the identity the caller holds still names the record inside it.
        File.Move(
            Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"),
            Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json"));

        Assert.Equal(NpcBody, repository.Get(Plugin, Npc)?.Body);
    }

    [Fact]
    public void Put_WithANewEditorIdOnACell_MovesItsDirectoryAndKeepsItsBlockFolders()
    {
        const string cellKey = "000A00:Fixture.esp";
        Track();
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
            File.ReadAllText(Path.Combine(blockFolder, $"NewCell - 000A00_{PluginName}", "RecordData.json")));
    }

    [Fact]
    public void Put_OverADocumentThatIsNotJson_RefusesWithAReason_AndLeavesTheFileAsItWas()
    {
        var repository = Opened();
        var file = Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json");
        File.WriteAllText(file, "this is not a document");

        var refusal = Assert.Throws<InvalidOperationException>(
            () => repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "RenamedNpc", WithEditorId("RenamedNpc"))));

        Assert.Contains("not a readable document", refusal.Message, StringComparison.Ordinal);
        Assert.Equal("this is not a document", File.ReadAllText(file));
        Assert.Equal([Path.GetFileName(file)], NpcFileNames());
    }

    [Fact]
    public void Put_OfTheEditorIdTheDocumentAlreadyHas_LeavesAFileSomethingElseRenamedWhereItIs()
    {
        var repository = Opened();
        var renamed = Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json");
        File.Move(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"), renamed);

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody));

        Assert.Equal([Path.GetFileName(renamed)], NpcFileNames());
    }

    [Fact]
    public void Get_WhenTwoFilesInTheGroupFolderClaimOneFormKey_Refuses()
    {
        var repository = Opened();
        File.WriteAllText(Path.Combine(NpcGroupFolder, $"AnImpostor - 000800_{PluginName}.json"), NpcBody);

        // A FormKey is unique within a mod, so answering with either file would be a guess.
        var refusal = Assert.Throws<AmbiguousSourceUnitException>(
            () => repository.Get(Plugin, new RecordIdentity(NpcFormKey, "npc_", "NeitherName")));

        Assert.Contains(NpcFormKey, refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfTheHeader_IsTheRootRecordDocument()
    {
        Track(
            new TreeFile(
                Path.Combine("plugin-source", PluginName, "RecordData.json"),
                System.Text.Encoding.UTF8.GetBytes("{\"MasterReferences\": []}")));
        var repository = RequireOpened();

        var header = new RecordIdentity($"000000:{PluginName}", "header", null);

        Assert.Equal("{\"MasterReferences\": []}", repository.Get(Plugin, header)?.Body);
    }
}
