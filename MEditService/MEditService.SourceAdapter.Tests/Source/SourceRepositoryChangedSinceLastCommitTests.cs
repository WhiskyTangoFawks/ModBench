using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryChangedSinceLastCommitTests : IDisposable
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

    private readonly ScratchDirectory _modFolder = new("medit-changed-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Tracked(params TreeFile[] extraFiles)
    {
        var files = new[] { new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody)) }.Concat(extraFiles).ToArray();
        PluginBaselines.Track(
            _modFolder, files);
        return SourceRepository.Open(TestMod.In(_modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    private static IReadOnlyDictionary<string, RecordChange> ChangesIn(SourceRepository repository) =>
        repository.ChangedSinceLastCommit(Plugin, SharedSchemaReflector.Instance.GetSchemas(Release));

    [Fact]
    public void AnUnstagedEditNeverGitAdded_ToAFileTrackAlreadyCommitted_IsModified()
    {
        var repository = Tracked();

        File.WriteAllText(Path.Combine(_modFolder, NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk), EditedBody);

        var only = Assert.Single(ChangesIn(repository));
        Assert.Equal(NpcFormKey, only.Key);
        Assert.Equal(RecordChange.Modified, only.Value);
    }

    [Fact]
    public void AStagedMoveOfAFileNoRecordIsFiledIn_OutOfAFolderNamedLikeTheTree_ChangesNoRecord_GuardingAgainstARenamesBareOldPathTokenReturningWhichNoRenamesTurnsOff()
    {
        var rootSegment = PluginSourceRoot.For(PluginName).Split(Path.DirectorySeparatorChar)[0];
        const int widthOfThePorcelainStatusCodeAnEntryParseDrops = 3;
        var lookalikeFolderName = new string('x', widthOfThePorcelainStatusCodeAnEntryParseDrops) + rootSegment;
        var oldFolder = Directory.CreateDirectory(Path.Combine(_modFolder, lookalikeFolderName, PluginName)).FullName;
        File.WriteAllText(Path.Combine(oldFolder, "notes.txt"), "notes");
        PluginBaselines.Track(_modFolder, [new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
        var repository = SourceRepository.Open(TestMod.In(_modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
        var gitDir = Path.Combine(_modFolder, ".git");
        GitProbe.Run(gitDir, _modFolder, "add", "-f", $"{lookalikeFolderName}/{PluginName}/notes.txt");
        GitProbe.Run(gitDir, _modFolder, "commit", "-q", "-m", "Their own file");
        GitProbe.Run(gitDir, _modFolder, "mv", $"{lookalikeFolderName}/{PluginName}/notes.txt", "notes.txt");

        Assert.Empty(ChangesIn(repository));
    }

    [Fact]
    public void ADocumentRenamedWithItsTextKept_ChangesNoRecord()
    {
        var repository = Tracked();
        var renamed = Path.Combine("plugin-source", PluginName, "Npcs", $"Renamed - 000800_{PluginName}.json");
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "mv",
            NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk.Replace('\\', '/'), renamed.Replace('\\', '/'));

        Assert.Empty(ChangesIn(repository));
    }

    [Fact]
    public void ADocumentRenamedAndEdited_IsModifiedNotDeletedAndAdded()
    {
        var repository = Tracked();
        var renamed = Path.Combine("plugin-source", PluginName, "Npcs", $"Edited - 000800_{PluginName}.json");
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "mv",
            NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk.Replace('\\', '/'), renamed.Replace('\\', '/'));
        File.WriteAllText(Path.Combine(_modFolder, renamed), EditedBody);

        var only = Assert.Single(ChangesIn(repository));
        Assert.Equal(NpcFormKey, only.Key);
        Assert.Equal(RecordChange.Modified, only.Value);
    }

    [Fact]
    public void AnEditToADocumentSortedBelowItsGroup_IsModified()
    {
        var sortedPath = Path.Combine("plugin-source", PluginName, "Npcs", "SortedByHand", $"Sorted - 000900_{PluginName}.json");
        var repository = Tracked(new TreeFile(sortedPath, Encoding.UTF8.GetBytes($"{{\"FormKey\":\"000900:{PluginName}\"}}")));

        File.WriteAllText(Path.Combine(_modFolder, sortedPath), $"{{\"FormKey\":\"000900:{PluginName}\",\"EditorID\":\"Edited\"}}");

        var only = Assert.Single(ChangesIn(repository));
        Assert.Equal($"000900:{PluginName}", only.Key);
        Assert.Equal(RecordChange.Modified, only.Value);
    }

    [Fact]
    public void ACleanTree_ChangesNoRecord()
    {
        Assert.Empty(ChangesIn(Tracked()));
    }

    [Fact]
    public void ADocumentTakenOutOfTheWorkingTree_ChangesNoRecordTheTreeHolds()
    {
        var repository = Tracked();

        File.Delete(Path.Combine(_modFolder, NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk));

        Assert.Empty(ChangesIn(repository));
    }

    [Fact]
    public void AChangedFileAnotherProcessHolds_ThrowsTheHoldUnwrapped_NeverReadsAsADeletionOrAnUnreadableDocument()
    {
        var repository = Tracked();
        var path = Path.Combine(_modFolder, NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk);
        File.WriteAllText(path, EditedBody);
        using var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);

        Assert.IsType<IOException>(Record.Exception(() => ChangesIn(repository)));
    }

    [Fact]
    public void ATrackedTreeWhoseStatusGitCannotReport_Throws_NeverReadsAsEveryRecordAdded()
    {
        var repository = Tracked();
        File.WriteAllText(Path.Combine(_modFolder, ".git", "index"), "not an index");

        Assert.Throws<GitCommandFailedException>(() => ChangesIn(repository));
    }

    [Fact]
    public void ATreeWithNoRepository_HasNoLastCommit_SoEveryRecordIsAdded()
    {
        var path = Path.Combine(_modFolder, NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk);
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, NpcBody);

        var only = Assert.Single(ChangesIn(SourceRepository.Over(TestMod.In(_modFolder), Release)));

        Assert.Equal((NpcFormKey, RecordChange.Added), (only.Key, only.Value));
    }

    [Fact]
    public void AnUntrackedDocument_IsAdded()
    {
        var repository = Tracked();
        var untrackedFileStandingInForAPutWhichNeverRunsGitAdd = Path.Combine("plugin-source", PluginName, "Npcs", $"Created - 000900_{PluginName}.json");
        File.WriteAllText(
            Path.Combine(_modFolder, untrackedFileStandingInForAPutWhichNeverRunsGitAdd), $"{{\"FormKey\":\"000900:{PluginName}\",\"EditorID\":\"Created\"}}");

        var only = Assert.Single(ChangesIn(repository));
        Assert.Equal($"000900:{PluginName}", only.Key);
        Assert.Equal(RecordChange.Added, only.Value);
    }

    [Fact]
    public void AnEditToTheHeadersRecordDataJson_NamesItsComputedFormKey_ThoughTheDocumentCarriesNoFormKey()
    {
        var headerPath = PluginSourceRoot.HeaderDocument(PluginName);
        var repository = Tracked(new TreeFile(headerPath, "{\"MasterReferences\": []}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, headerPath), "{\"MasterReferences\": [], \"Changed\": true}");

        var only = Assert.Single(ChangesIn(repository));
        Assert.Equal(PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName)), only.Key);
        Assert.Equal(RecordChange.Modified, only.Value);
    }

    [Theory]
    [InlineData("plugin-source/Test.esp/000800.json")]
    [InlineData("plugin-source/Test.esp/NotRecordData.json")]
    [InlineData("plugin-source/Test.esp/Npcs/000800.txt")]
    [InlineData("plugin-source/Test.esp/Npcs/000800")]
    [InlineData("plugin-source/Test.esp/Npcs/RecordData.json")]
    [InlineData("plugin-source/Test.esp/Cells/GroupRecordData.json")]
    [InlineData("plugin-source/Test.esp/NotARealFolder/000800.json")]
    public void AChangedFileThatIsNoRecordsDocument_ChangesNoRecord(string relativePath)
    {
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);
        var repository = Tracked(new TreeFile(normalized, "{}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, normalized), "{\"changed\":true}");

        Assert.Empty(ChangesIn(repository));
    }

    [Theory]
    [InlineData("Test.esp/Npcs/000800.json")]
    [InlineData("NotPluginSource/Test.esp/Npcs/000800.json")]
    public void AChangedFileOutsideThePluginsSourceRoot_ChangesNoRecord(string relativePath)
    {
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);
        var repository = Tracked();

        Directory.CreateDirectory(Path.Combine(_modFolder, Path.GetDirectoryName(normalized) ?? ""));
        File.WriteAllText(Path.Combine(_modFolder, normalized), "{\"FormKey\":\"000900:Test.esp\"}");

        Assert.Empty(ChangesIn(repository));
    }

    [Fact]
    public void AnEditToOneEmbeddedChild_NamesThatChildAndItsOwners_NeverItsSibling()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var edited = new PlacedObject(mod) { EditorID = "EditedRef" };
        var sibling = new PlacedObject(mod) { EditorID = "SiblingRef" };
        var topCell = new Cell(mod) { EditorID = "TopCell" };
        topCell.Temporary.Add(edited);
        topCell.Temporary.Add(sibling);
        var worldspace = new Worldspace(mod) { EditorID = "World", TopCell = topCell };
        var worldspacePath = PluginSourceRoot.ContainerDocument(Path.Combine(
            PluginSourceRoot.For(PluginName), "Worldspaces",
            $"{worldspace.EditorID} - {worldspace.FormKey.ID:X6}_{worldspace.FormKey.ModKey.FileName}"));
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var repository = Tracked(new TreeFile(worldspacePath, codec.SerializeToBytes(worldspace, Release)));

        var file = Path.Combine(_modFolder, worldspacePath);
        File.WriteAllText(file, File.ReadAllText(file).Replace("EditedRef", "Renamed", StringComparison.Ordinal));

        var changes = ChangesIn(repository);
        Assert.Equal(RecordChange.Modified, changes[edited.FormKey.ToString()]);
        Assert.Equal(RecordChange.Modified, changes[topCell.FormKey.ToString()]);
        Assert.Equal(RecordChange.Modified, changes[worldspace.FormKey.ToString()]);
        Assert.DoesNotContain(sibling.FormKey.ToString(), changes.Keys);
    }
}
