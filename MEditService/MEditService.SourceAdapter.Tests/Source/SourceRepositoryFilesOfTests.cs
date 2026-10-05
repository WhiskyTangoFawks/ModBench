using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryFilesOfTests : IDisposable
{
    private const string PluginName = "FilesOf.esp";
    private const string NpcFormKey = "000800:FilesOf.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:FilesOf.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "FilesOfMod");
    private static readonly RecordIdentity Npc = new(NpcFormKey, "npc_", NpcEditorId);

    private readonly ScratchDirectory _modFolder = new("medit-filesof-");

    public SourceRepositoryFilesOfTests()
    {
        PluginBaselines.Track(
            _modFolder,
            SourcePreset.Edits,
            [new TreeFile(Path.Combine(SourceRepository.RootFor(PluginName), "RecordData.json"), "{\"MasterReferences\": []}"u8.ToArray())]);
        Repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody));
        CommitSoBothRefsHoldTheTree();
    }

    private void CommitSoBothRefsHoldTheTree()
    {
        Git("add", "-A");
        Git("commit", "-q", "-m", "the fixture's npc");
    }

    public void Dispose() => _modFolder.Dispose();

    private string Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private SourceRepository Repository =>
        SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private string NpcRelativePath =>
        Repository.RelativePathOf(Plugin, Npc)
            ?? throw new InvalidOperationException($"Expected the tree to hold {NpcFormKey}.");

    private string NpcFullPath => Path.Combine(_modFolder, NpcRelativePath);

    private List<string> PathsOnDisk() =>
        [.. Directory.EnumerateFiles(
                Path.Combine(_modFolder, SourceRepository.RootFor(PluginName)), "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(_modFolder, file))
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void FilesOf_AnswersEveryFileUnderThePluginsSourceRoot_WithItsOwnBytes()
    {
        var files = Repository.FilesOf(Plugin).Files;

        Assert.Equal(PathsOnDisk(), [.. files.Select(f => f.RelativePath).Order(StringComparer.Ordinal)]);
        var npc = files.Single(f => f.RelativePath == NpcRelativePath);
        Assert.Equal(File.ReadAllBytes(NpcFullPath), npc.Content);
    }

    [Fact]
    public void FilesOf_AfterAPutThroughTheSameRepository_AnswersTheTreeAsItNowStands_NotFromAMemoOfBeforeTheWrite()
    {
        var repository = Repository;
        var before = repository.FilesOf(Plugin).Files.Count;

        repository.Put(
            Plugin,
            new SourceDocument(
                "000950:FilesOf.esp", "npc_", "MemoNpc",
                "{\n  \"FormKey\": \"000950:FilesOf.esp\",\n  \"EditorID\": \"MemoNpc\"\n}"));

        Assert.Equal(before + 1, repository.FilesOf(Plugin).Files.Count);
    }

    [Fact]
    public void FilesOf_WhenAFileCannotBeRead_NamesThatFile_AndAnswersNoFiles_NotHalfATreeACallerTakesForASmallerOne()
    {
        var npcRelativePath = NpcRelativePath;
        using var held = new FileStream(NpcFullPath, FileMode.Open, FileAccess.Read, FileShare.None);

        var files = Repository.FilesOf(Plugin);

        Assert.Equal(npcRelativePath, files.Unreadable);
        Assert.Empty(files.Files);
    }

    [Fact]
    public void FilesOf_ForAPluginTheTreeHoldsNoSourceFor_IsEmpty()
    {
        var stranger = new PluginAddress("Stranger.esp", Plugin.Origin);

        Assert.Empty(Repository.FilesOf(stranger).Files);
    }
}
